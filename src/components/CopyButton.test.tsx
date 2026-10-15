import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton';

describe('configuration copying', () => {
  it('copies exact file content and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CopyButton text={'version: 1\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy configuration' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard'),
    );
    expect(writeText).toHaveBeenCalledWith('version: 1\n');
  });

  it('provides a manual recovery when clipboard permission is denied', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException('Clipboard denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CopyButton text={'version: 1\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy configuration' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Select and copy the code'),
    );
    expect(screen.queryByRole('button', { name: 'Copied configuration' })).not.toBeInTheDocument();
  });
});
