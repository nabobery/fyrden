// Reads Fyrden's job payloads the way gitea/runner v6.0.0 does, and checks each against what
// Fyrden meant the runner to read. Each case is <name>.payload.json with <name>.expect.json;
// payload.runner-harness.test.ts writes them. See README.md.
//
// Reading follows internal/app/run/workflow.go (ReadWorkflowPayload, exactly one job) and
// act/runner/runner.go:226-259 and :372 (the matrix evaluated with EvaluateYamlNode and
// expanded, job-index and job-total read from the strategy, the name and labels
// interpolated), with an interpreter holding a secret DEMO, so a string evaluated twice shows.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"gitea.dev/actionslib/pkg/expreval"
	"gitea.dev/actionslib/pkg/exprparser"
	"gitea.dev/actionslib/pkg/model"
	"go.yaml.in/yaml/v4"
)

type input struct {
	Description string   `json:"description"`
	Required    bool     `json:"required"`
	Default     string   `json:"default"`
	Type        string   `json:"type"`
	Options     []string `json:"options"`
}

type expectation struct {
	Name            string   `json:"name"`
	Labels          []string `json:"labels"`
	Matrix          any      `json:"matrix"`
	Index           int      `json:"index"`
	Total           int      `json:"total"`
	FailFast        string   `json:"failFast"`
	MaxParallel     string   `json:"maxParallel"`
	Timeout         string   `json:"timeout"`
	ContinueOnError string   `json:"continueOnError"`
	Steps           int      `json:"steps"`
	On              []string `json:"on"`
	// workflow_dispatch inputs as the runner types them; null without the event.
	Inputs map[string]input `json:"inputs"`
}

// read gives what the runner reads from one payload, in the expectation's shape.
func read(data []byte) (expectation, error) {
	var got expectation
	var decodeErrs []string
	model.OnDecodeNodeError = func(_ yaml.Node, out any, err error) {
		decodeErrs = append(decodeErrs, fmt.Sprintf("%T: %v", out, err))
	}
	wf, err := model.ReadWorkflowPayload(bytes.NewReader(data))
	if err != nil {
		return got, fmt.Errorf("ReadWorkflowPayload: %w", err)
	}
	ids := wf.GetJobIDs()
	if len(ids) != 1 {
		return got, fmt.Errorf("multiple jobs found: %v", ids)
	}
	job := wf.GetJob(ids[0])
	if err := wf.DecodeRaw(); err != nil {
		return got, fmt.Errorf("workflow DecodeRaw: %w", err)
	}
	if err := job.DecodeRaw(); err != nil {
		return got, fmt.Errorf("job DecodeRaw: %w", err)
	}
	if job.If.Value != "${{ always() }}" {
		return got, fmt.Errorf("if is %q", job.If.Value)
	}
	interp := exprparser.NewInterpeter(&exprparser.EvaluationEnvironment{
		Secrets: map[string]string{"DEMO": "SECRET-VALUE"},
	}, exprparser.Config{Context: "job"})
	ee := expreval.New(interp.Evaluate)
	if job.Strategy != nil {
		if err := ee.EvaluateYamlNode(&job.Strategy.RawMatrix); err != nil {
			return got, fmt.Errorf("matrix: %w", err)
		}
		got.FailFast, got.MaxParallel = job.Strategy.FailFastString, job.Strategy.MaxParallelString
	}
	matrixes, err := job.GetMatrixes()
	if err != nil {
		return got, fmt.Errorf("GetMatrixes: %w", err)
	}
	if len(matrixes) != 1 {
		return got, fmt.Errorf("%d combinations", len(matrixes))
	}
	if len(matrixes[0]) > 0 {
		got.Matrix = matrixes[0]
	}
	var strategy struct {
		Index int `yaml:"job-index"`
		Total int `yaml:"job-total"`
	}
	_ = job.RawStrategy.Decode(&strategy)
	got.Index, got.Total = strategy.Index, strategy.Total
	if got.Name, err = ee.Interpolate(job.Name); err != nil {
		return got, fmt.Errorf("name: %w", err)
	}
	got.Labels = []string{}
	for _, label := range job.RunsOn() {
		value, err := ee.Interpolate(label)
		if err != nil {
			return got, fmt.Errorf("label: %w", err)
		}
		got.Labels = append(got.Labels, value)
	}
	got.Timeout, got.ContinueOnError, got.Steps = job.TimeoutMinutes, job.RawContinueOnError, len(job.Steps)
	if dispatch := wf.WorkflowDispatchConfig(); dispatch != nil {
		got.Inputs = map[string]input{}
		for id, in := range dispatch.Inputs {
			got.Inputs[id] = input{in.Description, in.Required, in.Default, in.Type, in.Options}
		}
	}
	got.On = wf.On()
	sort.Strings(got.On)
	if len(decodeErrs) > 0 {
		return got, fmt.Errorf("decode errors: %v", decodeErrs)
	}
	return got, nil
}

// normal turns a value into what JSON makes of it, so Go's YAML ints and JSON's floats compare.
func normal(v any) any {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("unmarshalable: %v", err)
	}
	var out any
	_ = json.Unmarshal(data, &out)
	return out
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . <directory of cases>")
		os.Exit(2)
	}
	payloads, _ := filepath.Glob(filepath.Join(os.Args[1], "*.payload.json"))
	if len(payloads) == 0 {
		fmt.Fprintln(os.Stderr, "no cases found")
		os.Exit(2)
	}
	failed := 0
	for _, path := range payloads {
		name := strings.TrimSuffix(filepath.Base(path), ".payload.json")
		data, _ := os.ReadFile(path)
		expectData, err := os.ReadFile(strings.TrimSuffix(path, ".payload.json") + ".expect.json")
		var want expectation
		if err == nil {
			err = json.Unmarshal(expectData, &want)
		}
		if err != nil {
			fmt.Printf("FAIL %s: expectation: %v\n", name, err)
			failed++
			continue
		}
		sort.Strings(want.On)
		got, err := read(data)
		if err != nil {
			fmt.Printf("FAIL %s: %v\n", name, err)
			failed++
			continue
		}
		if !reflect.DeepEqual(normal(got), normal(want)) {
			g, _ := json.Marshal(normal(got))
			w, _ := json.Marshal(normal(want))
			fmt.Printf("FAIL %s:\n  got  %.2000s\n  want %.2000s\n", name, g, w)
			failed++
			continue
		}
		fmt.Printf("ok   %s (%d bytes)\n", name, len(data))
	}
	fmt.Printf("%d cases, %d failed\n", len(payloads), failed)
	if failed > 0 {
		os.Exit(1)
	}
}
