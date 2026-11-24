# 0001. Keep rejected sync changes for manual handling

## Context

Mingzhang saves changes locally before sending them to the server. A rejected change may contain a ledger record the user still needs. Later changes can depend on it.

## Decision

Keep a rejected change at the head of the queue and show a persistent notice. Let the user retry it, edit and retry if it is a new or updated entry, copy its contents, or explicitly discard it after confirmation. Keep later changes queued in order while the head is blocked.

## Consequences

A startup replay can resolve a rejection if the server state has changed. Otherwise the blocked change remains available for manual handling across reloads and tabs. The server should continue accepting legitimate changes made offline, as in the fixes in commit `05057be`.

The queue stores one change per IndexedDB record, with an increasing key for send order and a status for pending, blocked or in-flight changes. Web Locks coordinate the flush loop when available. Without them, transactions claim the head and validate its identity before changing it. An abandoned claim expires after 180 seconds, which covers a mutation request and two snapshot requests plus a 45-second margin.

On startup and before flushing, import changes from the original localStorage array in order. Remember imported IDs so an older tab writing back a stale array cannot reintroduce them. Remove the imported IDs from a fresh read of the legacy array. If IndexedDB cannot open, use the original localStorage queue and show that multi-tab protection is reduced.

The server reads the ledger and mutation coverage in one snapshot. The client orders snapshots by database revision within a ledger epoch. Restore generates a new epoch and the restored snapshot reports changes already included in the backup. The client rebuilds the ledger from the latest snapshot and replays queued changes absent from its coverage. It can rebuild a lost snapshot cache on reconnect. When a queue append exceeds quota, the client keeps it in memory, warns before closing the page, and retries saving it after space is freed.

The trusted desktop client renders its persisted local snapshot before starting a server refresh; the web client still authenticates first. Reports are always projected from local state. If queued changes continue to arrive while a passive background snapshot is being fetched, the client keeps the local snapshot and retries reconciliation later without marking the ledger as synced. Manual refresh, mutation acknowledgement and conflict recovery still require a stable server snapshot.

Before confirming discard, check the live receipt. A committed change is acknowledged, and a change still in flight cannot be discarded. The server makes cancellation tombstones and mutation commits mutually exclusive by doing the check and write in the same `BEGIN IMMEDIATE` transaction. With no server snapshot the client disables discard until it can rebuild the ledger. A 401 closes recovery dialogs and leaves the queue accessible from sign-in.

Recovery edits compare the queued fields with the current server entry. A collision on a queued create is handled as an edit of the existing entry and uses its current version. A replacement gets a fresh receipt ID and keeps its position. For conflicts in account or display-order settings, users can redo the change from the latest settings and discard the stale edit. Category rebase is limited to additions that leave the existing catalog intact.
