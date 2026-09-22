package interaction

import (
	"github.com/multica-ai/multica/server/pkg/agent"
	"testing"
	"time"
)

func TestAcceptFencesAndDeduplicates(t *testing.T) {
	now := time.Now()
	fresh := func() Record {
		return Record{Owner: "owner", State: agent.InteractionSnapshot{State: agent.InteractionWorking, Activity: 1}, UpdatedAt: now, Deadline: now.Add(time.Hour)}
	}
	command := agent.InteractionCommand{ID: "send", Kind: "input", Activity: 1, Text: "correct this"}
	r := fresh()
	if err := r.Accept(command, "user", now); err != nil {
		t.Fatal(err)
	}
	r.Finishing = true
	if err := r.Accept(command, "user", now.Add(2*time.Hour)); err != nil {
		t.Fatalf("retry must remain idempotent: %v", err)
	}
	if len(r.Commands) != 1 {
		t.Fatal("duplicate command")
	}
	if r.Accept(command, "other-user", now) == nil {
		t.Fatal("actor mismatch accepted")
	}
	changed := command
	changed.Text = "different"
	if r.Accept(changed, "user", now) == nil {
		t.Fatal("mutated command accepted")
	}
	for _, tc := range []struct {
		name   string
		mutate func(*Record)
	}{
		{"finishing", func(r *Record) { r.Finishing = true }},
		{"expired", func(r *Record) { r.Deadline = now }},
		{"disconnected", func(r *Record) { r.UpdatedAt = now.Add(-16 * time.Second) }},
		{"stale activity", func(r *Record) { r.State.Activity = 2 }},
		{"starting", func(r *Record) { r.State.State = agent.InteractionStarting }},
		{"interrupting", func(r *Record) { r.State.State = agent.InteractionInterrupting }},
		{"finished", func(r *Record) { r.State.State = agent.InteractionFinished }},
		{"pending", func(r *Record) { r.Commands = []Input{{InteractionCommand: agent.InteractionCommand{ID: "prior"}}} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := fresh()
			tc.mutate(&r)
			if r.Accept(command, "user", now) == nil {
				t.Fatal("unsafe command accepted")
			}
		})
	}
}

func TestAcknowledgedCommandsDoNotBlockCorrection(t *testing.T) {
	now := time.Now()
	r := Record{State: agent.InteractionSnapshot{State: agent.InteractionAwaitingInput, Activity: 1}, UpdatedAt: now, Deadline: now.Add(time.Hour), Commands: []Input{{InteractionCommand: agent.InteractionCommand{ID: "stop"}, Receipt: &agent.InteractionReceipt{Outcome: "applied"}}}}
	if r.Pending() {
		t.Fatal("acknowledged interrupt is pending")
	}
	if err := r.Accept(agent.InteractionCommand{ID: "correction", Kind: "input", Activity: 1, Text: "try again"}, "user", now); err != nil {
		t.Fatal(err)
	}
	if !r.Pending() {
		t.Fatal("accepted input missing from inbox")
	}
}
