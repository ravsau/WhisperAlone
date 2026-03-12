import Foundation
import CoreGraphics

let src = CGEventSource(stateID: .combinedSessionState)

// Key code 9 = 'v'
let keyDown = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true)!
keyDown.flags = .maskCommand
keyDown.post(tap: .cgSessionEventTap)

let keyUp = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false)!
keyUp.flags = .maskCommand
keyUp.post(tap: .cgSessionEventTap)
