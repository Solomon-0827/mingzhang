// Reproduces the approved Variant design e45a9347-63ba-4e30-9a60-38d4e8b40814.
import AppKit
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
context.translateBy(x: 64, y: 960)
context.scaleBy(x: 1.72, y: -1.72)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor { NSColor(calibratedRed: r/255, green: g/255, blue: b/255, alpha: a) }
func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: NSColor) { c.setFill(); NSBezierPath(rect: NSRect(x:x,y:y,width:w,height:h)).fill() }
func tile(_ x: CGFloat, _ y: CGFloat, _ c: NSColor) { c.setFill(); NSBezierPath(roundedRect:NSRect(x:x,y:y,width:512,height:512),xRadius:115.2,yRadius:115.2).fill() }
tile(8,8,color(209,211,200,0.6))
tile(4,4,color(201,203,191))
tile(0,0,color(229,231,222))
NSGraphicsContext.saveGraphicsState()
NSBezierPath(roundedRect:NSRect(x:0,y:0,width:512,height:512),xRadius:115.2,yRadius:115.2).addClip()
for x in [64,160,256,352,448] { rect(CGFloat(x),0,1,512,color(0,0,0,0.05)) }
NSGraphicsContext.restoreGraphicsState()
let ink = color(42,39,36)
// 96 x 128 sun, 24pt gap, 112 x 192 moon, centred as in the original.
for (x,y,w,h) in [(140.0,192.0,96.0,128.0),(260.0,160.0,112.0,192.0)] {
 rect(x,y,w,10,ink); rect(x,y+h-10,w,10,ink); rect(x,y,10,h,ink); rect(x+w-10,y,10,h,ink)
}
rect(150,251,76,10,ink)
rect(270,220.667,92,10,ink); rect(270,281.333,92,10,ink)
context.saveGState(); context.translateBy(x:384,y:348); context.rotate(by:3 * .pi/180)
rect(-20,-20,40,40,color(166,64,54))
color(255,255,255,0.2).setStroke(); let seal=NSBezierPath(rect:NSRect(x:-12,y:-12,width:24,height:24));seal.lineWidth=1;seal.stroke()
context.restoreGState()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
