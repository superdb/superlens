//go:build js && wasm

// Command main is the SuperDB query engine of SuperLens compiled to
// WebAssembly.  It is built from inside the super repo (see
// scripts/build-wasm.sh) so it compiles against that checkout of SuperDB.
//
// It exposes these functions to JavaScript through golang-wasm:
//
//	setInputs(inputs)
//	run({program, inputs, useLoaded, inputFormat, outputFormat, limit, fusion}) -> Promise
//	version() -> string
//
// inputs is an array of {name, data} where data is a Uint8Array holding a
// file's contents.  setInputs copies the inputs into Go so later queries
// with useLoaded set can run over them without copying them again.  Each
// input is registered under its name so a query can refer to it (e.g., from
// 'data.json').  When the query doesn't begin with from, all of the inputs
// are scanned.  For BSUP output, run
// resolves to a Uint8Array; for other formats, to a string.  If limit is
// positive, output stops after (about) limit values and a QueryWarning
// control message says so.
//
// For compatibility with super's book playground, a string input field is
// also accepted.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"runtime/debug"
	"strings"
	"syscall/js"

	"github.com/superdb/super"
	"github.com/superdb/super/api"
	"github.com/superdb/super/api/queryio"
	"github.com/superdb/super/compiler"
	"github.com/superdb/super/compiler/ast"
	"github.com/superdb/super/compiler/parser"
	"github.com/superdb/super/pkg/storage"
	"github.com/superdb/super/runtime"
	"github.com/superdb/super/runtime/exec"
	"github.com/superdb/super/runtime/expr"
	"github.com/superdb/super/sio"
	"github.com/superdb/super/sio/anyio"
	"github.com/superdb/super/vector"
	"github.com/superdb/super/vector/vio"
	"github.com/teamortix/golang-wasm/wasm"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "unknown"

// loaded holds the inputs from the last call to setInputs.
var loaded = struct {
	engine *storage.InternalEngine
	paths  []string
}{engine: storage.NewInternalEngine()}

func main() {
	wasm.Expose("setInputs", setInputs)
	wasm.Expose("run", run)
	wasm.Expose("version", func() (string, error) { return version, nil })
	wasm.Ready()
	select {}
}

type input struct {
	Name string   `wasm:"name"`
	Data js.Value `wasm:"data"`
}

type opts struct {
	Program      string   `wasm:"program"`
	Input        js.Value `wasm:"input"`
	Inputs       []input  `wasm:"inputs"`
	UseLoaded    bool     `wasm:"useLoaded"`
	InputFormat  string   `wasm:"inputFormat"`
	OutputFormat string   `wasm:"outputFormat"`
	Limit        int      `wasm:"limit"`
	// Fusion keeps fusion values in the output.  By default they are
	// defused, as the super command does.
	Fusion bool `wasm:"fusion"`
}

func run(o opts) wasm.Promise {
	return wasm.NewPromise(func() (result any, err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("panic: %+v\n\n%s", r, debug.Stack())
			}
		}()
		eng, paths := loaded.engine, loaded.paths
		if !o.UseLoaded {
			if eng, paths, err = loadInputs(o.Inputs, o.Input); err != nil {
				return nil, err
			}
		}
		if o.OutputFormat == "" {
			o.OutputFormat = "bsup"
		}
		out, compileErr, err := runQuery(o, eng, paths, true)
		if compileErr && len(paths) > 0 {
			// The query may name its own sources (e.g., in a SQL FROM
			// clause), which can't be combined with the implied scan of
			// the inputs, so try again without it.
			out2, _, err2 := runQuery(o, eng, paths, false)
			// Use the second attempt if it worked, or if the first error
			// was about combining the query's sources with the scan, in
			// which case the second error is the one that matters.
			if err2 == nil || strings.Contains(err.Error(), "parent") {
				out, err = out2, err2
			}
		}
		if err != nil {
			return nil, err
		}
		if o.OutputFormat == "bsup" || o.OutputFormat == "parquet" || o.OutputFormat == "arrows" {
			b := js.Global().Get("Uint8Array").New(len(out))
			js.CopyBytesToJS(b, out)
			return b, nil
		}
		return string(out), nil
	})
}

func setInputs(inputs []input) (int, error) {
	eng, paths, err := loadInputs(inputs, js.Undefined())
	if err != nil {
		return 0, err
	}
	loaded.engine, loaded.paths = eng, paths
	return len(paths), nil
}

func loadInputs(inputs []input, text js.Value) (*storage.InternalEngine, []string, error) {
	eng := storage.NewInternalEngine()
	var paths []string
	seen := map[string]bool{}
	for _, in := range inputs {
		if in.Data.Type() != js.TypeObject || !in.Data.InstanceOf(js.Global().Get("Uint8Array")) {
			return nil, nil, fmt.Errorf("input %q: data must be a Uint8Array", in.Name)
		}
		b := make([]byte, in.Data.Length())
		js.CopyBytesToGo(b, in.Data)
		path, err := uniquePath(in.Name, seen)
		if err != nil {
			return nil, nil, err
		}
		eng.AddBytes(path, b)
		paths = append(paths, path)
	}
	if text.Type() == js.TypeString {
		if s := text.String(); strings.TrimSpace(s) != "" {
			path, err := uniquePath("input", seen)
			if err != nil {
				return nil, nil, err
			}
			eng.AddBytes(path, []byte(s))
			paths = append(paths, path)
		}
	}
	return eng, paths, nil
}

// uniquePath returns the path under which to register a file so that a
// query naming the file (e.g., from 'data.json') finds it.  This is the
// file's URI as the storage layer resolves it, made unique among the inputs.
func uniquePath(name string, seen map[string]bool) (string, error) {
	name = strings.TrimLeft(strings.ReplaceAll(name, "\\", "/"), "/")
	if name == "" {
		name = "input"
	}
	for k := 1; ; k++ {
		candidate := name
		if k > 1 {
			candidate = fmt.Sprintf("%s (%d)", name, k)
		}
		u, err := storage.ParseURI(candidate)
		if err != nil {
			return "", fmt.Errorf("input %q: %w", name, err)
		}
		if path := u.String(); !seen[path] {
			seen[path] = true
			return path, nil
		}
	}
}

// runQuery runs the query and returns its output.  compileErr is true if
// the query failed to parse or compile.
func runQuery(o opts, eng storage.Engine, paths []string, scan bool) ([]byte, bool, error) {
	parsed, err := parser.ParseText(o.Program)
	if err != nil {
		return nil, true, err
	}
	if scan && len(paths) > 0 && !startsWithFrom(parsed.Parsed()) {
		if parsed.Script() != nil {
			return nil, true, errors.New("a script of multiple statements must name its inputs (e.g., from 'file.json')")
		}
		parsed.PrependFileScan(paths)
	}
	env := exec.NewEnvironment(eng, nil)
	if f := o.InputFormat; f != "" && f != "auto" {
		env.ReaderOpts.Format = f
	}
	ctx := context.Background()
	sctx := super.NewContext()
	query, err := runtime.CompileQuery(ctx, sctx, compiler.NewCompilerWithEnv(env), parsed)
	if err != nil {
		return nil, true, err
	}
	defer query.Pull(true)
	var buf bytes.Buffer
	w, err := newWriter(&buf, sctx, o.OutputFormat)
	if err != nil {
		return nil, false, err
	}
	var defuse *expr.SuperDefuse
	if !o.Fusion {
		defuse = expr.NewSuperDefuse(sctx)
	}
	var n int
	for {
		vec, err := query.Pull(false)
		if err != nil {
			w.Close()
			return nil, false, err
		}
		if vec == nil {
			break
		}
		if _, ok := vec.(*vector.Control); ok {
			continue
		}
		if vec, _ = vector.Unlabel(vec); vec == nil {
			continue
		}
		if defuse != nil {
			vec = defuse.Eval(vec)
		}
		if err := w.Push(vec); err != nil {
			w.Close()
			return nil, false, err
		}
		n += int(vec.Len())
		if o.Limit > 0 && n >= o.Limit {
			if cw, ok := w.(controlWriter); ok {
				msg := fmt.Sprintf("showing the first %d values; refine the query to see the rest", n)
				if err := cw.WriteControl(api.QueryWarning{Warning: msg}); err != nil {
					w.Close()
					return nil, false, err
				}
			}
			break
		}
	}
	if err := w.Close(); err != nil {
		return nil, false, err
	}
	return buf.Bytes(), false, nil
}

// startsWithFrom is true if a query begins with a from operator, in which case
// it names its own inputs.
func startsWithFrom(seq ast.Seq) bool {
	if len(seq) == 0 {
		return false
	}
	switch op := seq[0].(type) {
	case *ast.FromOp:
		return true
	case *ast.ScopeOp:
		return startsWithFrom(op.Body)
	}
	return false
}

type writer interface {
	vio.Pusher
	io.Closer
}

type controlWriter interface {
	WriteControl(any) error
}

// newWriter returns a writer for the output format.  BSUP output uses the
// service's query writer so it can carry control messages (e.g., warnings).
func newWriter(w io.Writer, sctx *super.Context, format string) (writer, error) {
	if format == "bsup" {
		return queryio.NewBSUPWriter(w), nil
	}
	return anyio.NewWriter(sctx, sio.NopCloser(w), anyio.WriterOpts{Format: format})
}
