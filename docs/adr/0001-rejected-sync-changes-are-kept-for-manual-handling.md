# 0001. Keep rejected sync changes for manual handling

## Context

Mingzhang saves changes locally before sending them to the server. A rejected change may contain a ledger record the user still needs. Later changes can depend on it.

## Decision

Keep a rejected change at the head of the queue and show a persistent notice. Let the user retry it, edit and retry if it is a new or updated entry, copy its contents, or explicitly discard it after confirmation. Keep later changes queued in order while the head is blocked.

## Consequences

A startup replay can resolve a rejection if the server state has changed. Otherwise the blocked change remains available for manual handling across reloads and tabs. The server should continue accepting legitimate changes made offline, as in the fixes in commit `05057be`.

The original queue key and item format are shared with earlier tabs. Rejection metadata is saved separately by mutation ID. The server commits each queued mutation together with its receipt so that overlapping replays can return the original result. Tabs use Web Locks when available and serialize within the tab otherwise.

Recovery edits compare the queued fields with the current server entry and start with the server values. When a queued create already has a matching server ID, recovery updates that entry using its current version. Saving an edited payload starts a new sync attempt with a new receipt ID.
