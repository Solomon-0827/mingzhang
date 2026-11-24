export function canOpenCachedLedgerBeforeAuthentication(desktopClient: boolean, hasSnapshot: boolean) {
  return desktopClient && hasSnapshot;
}
