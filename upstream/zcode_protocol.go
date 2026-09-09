// Package zcode is a self-contained client for the ZCode Protocol spoken by
// `zcode app-server` (zcode 0.16.x). It is the reference transport for a
// native Multica provider driver — see upstream/INTEGRATION.md.
//
// Wire format: one JSON message per line. Requests are {id, method, params};
// responses are {id, result|error}; notifications carry {method, params}. The
// server also issues requests to the client, which must be answered or calls
// hang — Server.autoAnswer covers the known ones.
package zcode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

// Message is any protocol frame.
type Message struct {
	ID     *string         `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// Error is a protocol-level error.
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string { return fmt.Sprintf("zcode: %s (code %d)", e.Message, e.Code) }

// Event is a session/event notification payload.
type Event struct {
	SessionID string          `json:"sessionId"`
	EventID   string          `json:"eventId"`
	Seq       int64           `json:"seq"`
	Payload   json.RawMessage `json:"payload"`
}

// CompletionEvent extracts the terminal turn event (contains response+usage).
type CompletionEvent struct {
	Response string `json:"response"`
	Usage    struct {
		InputTokens  int64 `json:"inputTokens"`
		OutputTokens int64 `json:"outputTokens"`
		TotalTokens  int64 `json:"totalTokens"`
		CacheRead    int64 `json:"cacheReadTokens"`
		CacheWrite   int64 `json:"cacheWriteTokens"`
	} `json:"usage"`
	Kind string `json:"kind"` // usually empty on the completion event
}

// IsCompletion reports whether the event payload is the terminal turn event.
func IsCompletion(payload json.RawMessage) bool {
	var probe struct {
		Response *json.RawMessage `json:"response"`
		Usage    *json.RawMessage `json:"usage"`
	}
	return json.Unmarshal(payload, &probe) == nil && probe.Response != nil && probe.Usage != nil
}

// Server is a running `zcode app-server` child.
type Server struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	events chan Event
	dead   chan struct{}

	mu      sync.Mutex
	pending map[string]chan Message
	nextID  int
}

// Start spawns `node <zcodeCjs> app-server` rooted at workdir.
func Start(ctx context.Context, zcodeCjs, nodeBin, workdir string) (*Server, error) {
	if nodeBin == "" {
		nodeBin = "node"
	}
	cmd := exec.CommandContext(ctx, nodeBin, zcodeCjs, "app-server")
	cmd.Dir = workdir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &Server{
		cmd:     cmd,
		stdin:   stdin,
		events:  make(chan Event, 256),
		dead:    make(chan struct{}),
		pending: map[string]chan Message{},
	}
	go s.readLoop(stdout)
	go func() { _ = cmd.Wait(); close(s.dead) }()
	return s, nil
}

// Events exposes the session/event channel.
func (s *Server) Events() <-chan Event { return s.events }

// Done is closed when the child exits.
func (s *Server) Done() <-chan struct{} { return s.dead }

func (s *Server) readLoop(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1<<20), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg Message
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}
		switch {
		case msg.ID != nil && (msg.Result != nil || msg.Error != nil):
			s.mu.Lock()
			ch := s.pending[*msg.ID]
			delete(s.pending, *msg.ID)
			s.mu.Unlock()
			if ch != nil {
				ch <- msg
			}
		case msg.Method == "session/event":
			var ev Event
			if json.Unmarshal(msg.Params, &ev) == nil {
				select {
				case s.events <- ev:
				default: // drop on overflow; consumers re-read via session/read
				}
			}
		case msg.Method != "":
			s.autoAnswer(msg)
		}
	}
}

// autoAnswer replies to server→client requests. The runtime-preferences
// handshake requires an explicit boolean; everything else (MCP auth headers,
// telemetry) accepts an empty result. Permission prompts are only expected
// outside yolo mode — a driver that wants interactive permissions should
// intercept `interaction/requestPermission` here instead.
func (s *Server) autoAnswer(req Message) {
	if req.ID == nil {
		return
	}
	result := json.RawMessage("{}")
	if req.Method == "session/requestRuntimePreferences" {
		result = json.RawMessage(`{"nativeSearchEnhancementsEnabled":false}`)
	}
	s.reply(*req.ID, result)
}

func (s *Server) reply(id string, result json.RawMessage) {
	frame, _ := json.Marshal(map[string]any{"id": id, "result": result})
	_, _ = s.stdin.Write(append(frame, '\n'))
}

// Call sends a request and waits for its response.
func (s *Server) Call(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	id := fmt.Sprintf("zc-%d", time.Now().UnixNano())
	frame, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	ch := make(chan Message, 1)
	s.mu.Lock()
	s.pending[id] = ch
	s.mu.Unlock()
	if _, err := s.stdin.Write(append(frame, '\n')); err != nil {
		return nil, err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-time.After(timeout):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, fmt.Errorf("%s timed out after %s", method, timeout)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// StartSession performs handshake: create (or resume) + yolo + subscribe.
func (s *Server) StartSession(ctx context.Context, workdir, resumeSessionID string) (string, error) {
	if resumeSessionID != "" {
		var res struct {
			Session struct {
				SessionID string `json:"sessionId"`
			} `json:"session"`
		}
		ok, err := s.call(ctx, "session/resume", map[string]any{"sessionId": resumeSessionID}, &res)
		if err == nil && ok {
			return res.Session.SessionID, nil
		}
		// fall through to a fresh session
	}
	var res struct {
		Session struct {
			SessionID string `json:"sessionId"`
		} `json:"session"`
	}
	if _, err := s.call(ctx, "session/create", map[string]any{
		"workspace": map[string]any{"workspacePath": workdir, "workspaceKey": workdir},
	}, &res); err != nil {
		return "", err
	}
	sid := res.Session.SessionID
	if sid == "" {
		return "", fmt.Errorf("session/create returned no sessionId")
	}
	if _, err := s.call(ctx, "session/setMode", map[string]any{"sessionId": sid, "mode": "yolo"}, nil); err != nil {
		return "", err
	}
	if _, err := s.call(ctx, "session/subscribe", map[string]any{"sessionId": sid, "deliveryKind": "desktop-continuous"}, nil); err != nil {
		return "", err
	}
	return sid, nil
}

// Send submits a prompt; completion arrives as a session/event.
func (s *Server) Send(ctx context.Context, sessionID, content string) error {
	_, err := s.call(ctx, "session/send", map[string]any{"sessionId": sessionID, "content": content}, nil)
	return err
}

// call is Call with optional out-unmarshal.
func (s *Server) call(ctx context.Context, method string, params any, out any) (bool, error) {
	raw, err := s.Call(ctx, method, params, 15*time.Second)
	if err != nil {
		return false, err
	}
	if out != nil && raw != nil {
		return json.Unmarshal(raw, out) == nil, nil
	}
	return raw != nil, nil
}

// Close terminates the child.
func (s *Server) Close() { _ = s.cmd.Process.Kill() }
