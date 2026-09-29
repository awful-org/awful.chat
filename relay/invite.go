package main

import (
	"encoding/json"
	"net/http"
)

func registerInviteEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/invite", postOnly(handleInviteCreate))
	mux.HandleFunc("/invite/", getOnly(handleInviteResolve))
}

func inviteJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	})
}

// POST /invite carries only bounded OPAQUE login messages and encrypted transfer.
func handleInviteCreate(w http.ResponseWriter, r *http.Request) { handlePairing(w, r) }

// No plaintext alias oracle survives the cutover, including on old clients.
func handleInviteResolve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	apiError(w, r, "Legacy invitations retired; request a new secure invitation", http.StatusGone)
}

func postOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			h(w, r)
		case http.MethodOptions:
			preflight(w, r)
		default:
			w.Header().Set("Allow", "POST, OPTIONS")
			apiError(w, r, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}
