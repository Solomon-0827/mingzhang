# 0001. Keep rejected sync changes for manual handling

## Context

Mingzhang saves changes locally before sending them to the server. A rejected change may contain a ledger record the user still needs. Later changes can depend on it.

## Decision

Keep a rejected change at the head of the queue and show a persistent notice. Let the user retry it, edit and retry if it is a new or updated entry, copy its contents, or explicitly discard it after confirmation. Keep later changes queued in order while the head is blocked.

## Consequences

A startup replay can resolve a rejection if the server state has changed. Otherwise the blocked change remains available for manual handling across reloads and tabs. The server should continue accepting legitimate changes made offline, as in the fixes in commit `05057be`.
