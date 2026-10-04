# `/api/reactions` — the backend contract for milestone reactions

**Status: not implemented. This is the contract a backend must satisfy.**

The client in `assets/js/milestone-detail.js` is complete and ships working.
What it does *not* ship is a place to put reactions: this repository is published
by GitHub Pages, which serves static files and answers nothing but them. So
reactions are written to `localStorage` first and mirrored to `/api/reactions`
when — and only when — that endpoint answers.

Until one exists, the card tells the reader so in plain words rather than implying
their reaction was seen by anyone:

> Free to post, signed in or not. Kept in this browser only — no shared backend yet.

That line is not decorative. It is driven by the outcome of the first write, and
the check that it flips to "shared" is an e2e test. Do not make the UI claim
sharing without the server actually returning a canonical reply.

## Why local-first rather than server-first

1. **Posting stays free and instant on a static host.** A reaction is a one-click
   gesture; making it wait on a network round-trip to a service that does not
   exist would make the feature feel broken rather than provisional.
2. **Anonymous posting has to be genuinely anonymous.** Anonymous votes are
   derived from a random id in `localStorage` that cannot be resolved to a person.
   Any server-side identity for an anonymous reader would weaken that, so the
   server is told the id it is given and nothing more.
3. **One merge rule, not two.** The client merges a server reply by `Math.max`
   per emoji, never by addition. A server that returns absolute counts can
   therefore never be double-counted by a client that had already seen some.

## The contract

Same-origin. `credentials: 'same-origin'`, so a session cookie set by
`auth-bar.js`'s GitHub OAuth is sent along automatically — but nothing in the
client depends on it.

### `POST /api/reactions`

Request body:

```jsonc
{
  // Always present. `id` is "gh:<session_id>" for a signed-in reader and
  // "anon:<local id>" for everyone else. `kind` is "github" | "anonymous".
  "identity": { "id": "anon:7f3c…", "kind": "anonymous", "label": "Anonymous" },

  // Exactly one of the two below is normally sent.
  "milestone_id": "ms-4ff7841d61d0",

  // A reaction toggle. `reacted: true` adds, false removes. The emoji must be one
  // of the twelve in REACTION_EMOJI; the server should reject anything else
  // rather than storing it, because the client will never render it.
  "reaction": { "emoji": "🚀", "reacted": true },

  // A comment. Already trimmed, control-stripped and truncated to 280 characters
  // by the client; the server must enforce the limit itself.
  "comment": { "text": "The primary source is a preprint." }
}
```

Success — `200` with the canonical state of that milestone:

```jsonc
{
  "milestone_id": "ms-4ff7841d61d0",
  "counts": { "🚀": 4, "🔥": 2 },
  "mine":   { "🚀": true },
  "comments": [
    { "id": "anon:7f3c:lqz3k", "owner": "anon:7f3c",
      "author": "Anonymous", "kind": "anonymous",
      "text": "The primary source is a preprint.", "ts": 1767225600000 }
  ]
}
```

Rules the server owns:

| Rule | Why it is the server's job |
| --- | --- |
| `counts` are absolute, keyed by emoji | The client unions by `max`; only the server can be authoritative. |
| `mine` reflects *this* identity | Only the server knows whether a vote was already counted. The client's own flag is local optimism. |
| One reaction per `(identity, milestone, emoji)` | Otherwise a reader can inflate a tally by posting twice. This is the whole point of storing `mine`. |
| `comments[].text` ≤ 280 chars, `author` ≤ 64 chars | The client truncates its own copy; it does not get to decide for other clients. |
| `comments[].id` is stable and unique | The client de-duplicates by it, so a re-send cannot double a row. |
| Unknown emoji and unknown `milestone_id` are dropped, not stored | A payload must not be able to grow an unbounded key space. |
| Rate-limit per identity and per IP | The client's 15 s cooldown is an honesty measure, not a control. |

Any non-2xx response is treated as "there is no backend here" and the client
falls back to local-only. That is deliberate: a 500 must not lose the reaction the
reader just made, and it must not leave the composer stuck in a pending state.
Return `2xx` only when the write actually persisted.

### `GET /api/reactions?milestone_id=<id>`

Returns the same shape. The client calls this at most once per milestone, and
**only after a write has proved the endpoint is live** — so a static host is never
charged for a request it cannot answer.

## Verifying an implementation

The e2e suite already exercises both sides of this contract against a stub:

* `bunx playwright test e2e/milestone-detail.spec.mjs` — the default stub answers
  `200` with an empty canonical reply, and one block stands in for a missing
  backend with `404` and asserts the composer falls back to local-only wording.
* `test/milestone-detail.test.mjs` — the merge arithmetic the client applies to
  your reply (`Math.max` per emoji, never addition).

To point the real thing at a live endpoint, set `REMOTE_ENDPOINT` in
`assets/js/milestone-detail.js` and delete the `page.route` stub in the spec's
`beforeEach`. The `REMOTE_ENDPOINT` assertion in the unit suite will tell you if
you changed one and not the other.

## Privacy

Deliberately collected, and nothing else:

* the reaction emoji and the milestone id;
* for a comment: the text, a display label, and a timestamp;
* for identity: an opaque id and whether it came from GitHub.

No email, no IP logging beyond what the host does by default, no fingerprinting,
no third-party request. If the reader is signed in through `auth-bar.js`, the
GitHub login is visible on their own comments — that is the trade for attribution
and it is opt-in by signing in. The client's identity resolution, including the
rule that an expired session falls back to anonymous, is in `resolveIdentity` and
covered by `test/milestone-detail.test.mjs`.