import { joinWaitlist } from '../../waitlist';
import type { WaitlistResult } from '../../waitlist';

const INVALID_EMAIL = 'That email doesn’t look right.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESULT_NOTES: Record<WaitlistResult, string> = {
  joined: 'You’re on the list. We’ll email you when your spot opens.',
  already: 'You’re already on the list. We’ll be in touch.',
};

// The page's markup is static HTML in a shadow root, so its forms are wired here rather than
// rendered by WaitlistForm.
export function wireWaitlistForms(root: ParentNode) {
  for (const form of root.querySelectorAll<HTMLFormElement>('.waitlist')) {
    const input = form.querySelector('input')!;
    const button = form.querySelector('button')!;
    const note = form.querySelector<HTMLElement>('.note')!;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (button.disabled) return;
      if (!EMAIL_PATTERN.test(input.value.trim())) {
        note.textContent = INVALID_EMAIL;
        return;
      }
      button.disabled = true;
      note.textContent = '';
      try {
        note.textContent = RESULT_NOTES[await joinWaitlist(input.value, [])];
      } catch (failure) {
        note.textContent = (failure as Error).message;
      } finally {
        button.disabled = false;
      }
    });
    input.addEventListener('input', () => {
      note.textContent = '';
    });
  }
}
