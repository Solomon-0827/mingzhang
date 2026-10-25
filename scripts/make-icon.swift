import AppKit
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
NSColor(calibratedRed: 0.125, green: 0.36, blue: 0.298, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 50, y: 50, width: 924, height: 924), xRadius: 210, yRadius: 210).fill()
NSColor(calibratedRed: 0.94, green: 0.96, blue: 0.88, alpha: 1).setStroke()
let book = NSBezierPath()
book.lineWidth = 42
book.lineJoinStyle = .round
book.lineCapStyle = .round
book.move(to: NSPoint(x: 512, y: 300))
book.curve(to: NSPoint(x: 270, y: 350), controlPoint1: NSPoint(x: 430, y: 350), controlPoint2: NSPoint(x: 340, y: 370))
book.line(to: NSPoint(x: 270, y: 712))
book.curve(to: NSPoint(x: 512, y: 660), controlPoint1: NSPoint(x: 360, y: 735), controlPoint2: NSPoint(x: 445, y: 710))
book.curve(to: NSPoint(x: 754, y: 712), controlPoint1: NSPoint(x: 580, y: 710), controlPoint2: NSPoint(x: 665, y: 735))
book.line(to: NSPoint(x: 754, y: 350))
book.curve(to: NSPoint(x: 512, y: 300), controlPoint1: NSPoint(x: 680, y: 370), controlPoint2: NSPoint(x: 590, y: 350))
book.line(to: NSPoint(x: 512, y: 660))
book.stroke()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
