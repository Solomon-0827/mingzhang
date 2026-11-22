# Mingzhang glossary

Mingzhang (明账) is an offline-first personal ledger. An entry records an amount in CNY cents and the accounts it affects.

## Entry kind (类型)

| Kind | Account roles and related fields |
| --- | --- |
| Income (收入), expense (支出) | One account and a category. |
| Transfer (转账) | A source (转出账户) and a different destination (转入账户). |
| Refund (退款) | A receiving account and the original expense. The refund uses the original category. |
| Lend (借出), borrow (借入) | One account and a counterparty (往来对象). |
| Repay (还款), collect (回款) | A funding account (付款账户 or 收款账户) and a liability (负债账户) or receivable (债权账户) respectively. Entry-linked settlements use the original borrow or lend entry. |
| Balance increase (余额调增), balance decrease (余额调减) | An adjustment to one account's balance. |

## Sync

**Queued change.** A locally saved change waiting for the server to accept it.

**Blocked change.** A rejected change retained at the head of the queue for manual handling. [ADR 0001](docs/adr/0001-rejected-sync-changes-are-kept-for-manual-handling.md)
