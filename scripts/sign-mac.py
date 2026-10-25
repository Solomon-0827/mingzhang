"""Ad-hoc sign local preview packages. This is NOT Apple Developer ID notarization."""

import plistlib
import subprocess
from pathlib import Path

for app in Path("desktop/out").glob("*/明账.app"):
    info = app / "Contents/Info.plist"
    with info.open("rb") as stream:
        data = plistlib.load(stream)
    data["LSApplicationCategoryType"] = "public.app-category.finance"
    for key in [
        "NSCameraUsageDescription",
        "NSMicrophoneUsageDescription",
        "NSAudioCaptureUsageDescription",
        "NSBluetoothAlwaysUsageDescription",
        "NSBluetoothPeripheralUsageDescription",
    ]:
        data.pop(key, None)
    with info.open("wb") as stream:
        plistlib.dump(data, stream)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    print("Verified:", app)
