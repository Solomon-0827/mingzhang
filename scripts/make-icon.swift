import AppKit
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let tile = NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 210, yRadius: 210)
NSGradient(starting: NSColor(calibratedRed: 0.09, green: 0.39, blue: 0.36, alpha: 1), ending: NSColor(calibratedRed: 0.035, green: 0.19, blue: 0.23, alpha: 1))!.draw(in: tile, angle: -65)
NSColor(calibratedRed: 0.97, green: 0.95, blue: 0.87, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 252, y: 226, width: 460, height: 572), xRadius: 54, yRadius: 54).fill()
NSColor(calibratedRed: 0.86, green: 0.90, blue: 0.81, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 252, y: 226, width: 50, height: 572), xRadius: 24, yRadius: 24).fill()
NSColor(calibratedRed: 0.12, green: 0.38, blue: 0.34, alpha: 1).setStroke()
for (y, width) in [(620.0, 210.0), (510.0, 270.0), (400.0, 160.0)] {
 let line = NSBezierPath(); line.lineWidth = 34; line.lineCapStyle = .round
 line.move(to: NSPoint(x: 365, y: y)); line.line(to: NSPoint(x: 365 + width, y: y)); line.stroke()
}
NSColor(calibratedRed: 0.94, green: 0.73, blue: 0.35, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 636, y: 656, width: 174, height: 174)).fill()
NSColor(calibratedRed: 1, green: 0.91, blue: 0.65, alpha: 1).setStroke()
let gleam = NSBezierPath(); gleam.lineWidth = 12; gleam.lineCapStyle = .round
gleam.move(to: NSPoint(x: 684, y: 773)); gleam.curve(to: NSPoint(x: 728, y: 792), controlPoint1: NSPoint(x: 696, y: 788), controlPoint2: NSPoint(x: 711, y: 794)); gleam.stroke()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
