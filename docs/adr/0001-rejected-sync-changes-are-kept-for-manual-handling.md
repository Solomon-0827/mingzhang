# 0001. Keep rejected sync changes for manual handling

## Context

Mingzhang saves changes locally before sending them to the server. A rejected change may contain a ledger record the user still needs. Later changes can depend on it.

## Decision

Keep a rejected change at the head of the queue and show a persistent notice. Let the user retry it, edit and retry if it is a new or updated entry, copy its contents, or explicitly discard it after confirmation. Keep later changes queued in order while the head is blocked.

## Consequences

A startup replay can resolve a rejection if the server state has changed. Otherwise the blocked change remains available for manual handling across reloads and tabs. The server should continue accepting legitimate changes made offline, as in the fixes in commit `05057be`.

The original queue key, item format and stored array order are shared with earlier tabs. Rejection metadata is saved separately by mutation ID. Short writes use Web Locks when available and an IndexedDB transaction across tabs that support it. A localStorage lease protects the current send from discard during network I/O. Acknowledgement removes the mutation by ID from the current array.

The server commits each queued mutation together with its receipt so that overlapping replays can return the original result. Clients read the ledger and matching receipts together so they only apply the changes still outstanding. If storage fills up, the client warns about page-only saves and uses the space freed by durable acknowledgements to save them in order.

Recovery edits compare the queued fields with the current server entry and start with the server values. When a queued create already has a matching server ID, recovery updates that entry using its current version. A user can also confirm reapplying a category, display order or versioned account change to the latest server data. A replacement gets a new receipt ID and keeps its position in the queue.
