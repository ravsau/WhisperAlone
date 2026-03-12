import { clipboard } from 'electron';
import { execSync } from 'child_process';

const PASTE_DELAY_MS = 150;
const RESTORE_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Use JXA (JavaScript for Automation) to call CoreGraphics CGEventPost directly.
// This only needs Accessibility permission — NO Automation/System Events permission.
const JXA_PASTE_SCRIPT = `
ObjC.import("CoreGraphics");
var src = $.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);
var keyDown = $.CGEventCreateKeyboardEvent(src, 9, true);
$.CGEventSetFlags(keyDown, $.kCGEventFlagMaskCommand);
$.CGEventPost($.kCGSessionEventTap, keyDown);
delay(0.05);
var keyUp = $.CGEventCreateKeyboardEvent(src, 9, false);
$.CGEventSetFlags(keyUp, $.kCGEventFlagMaskCommand);
$.CGEventPost($.kCGSessionEventTap, keyUp);
`;

export async function injectText(text: string): Promise<void> {
  // Save current clipboard
  const previousText = clipboard.readText();
  const previousImage = clipboard.readImage();

  // Write transcription to clipboard
  clipboard.writeText(text);

  await delay(PASTE_DELAY_MS);

  try {
    execSync(`osascript -l JavaScript -e '${JXA_PASTE_SCRIPT}'`, { timeout: 5000 });
    console.log('[Injector] Pasted via JXA CGEvent');
  } catch (err) {
    console.error('[Injector] Paste failed:', (err as Error).message);
    console.log('[Injector] Text is on clipboard — manually Cmd+V');
    return;
  }

  // Restore original clipboard after paste completes
  await delay(RESTORE_DELAY_MS);

  if (previousText) {
    clipboard.writeText(previousText);
  } else if (!previousImage.isEmpty()) {
    clipboard.writeImage(previousImage);
  } else {
    clipboard.clear();
  }
}
