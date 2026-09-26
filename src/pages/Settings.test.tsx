import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createConfiguration } from '../configuration';
import { Settings } from './Settings';

describe('repository configuration builder', () => {
  it('exports the selected package manager, checks, and repair limit', () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Package manager'), { target: { value: 'pnpm' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Lint/ }));
    fireEvent.change(screen.getByLabelText('Maximum repair attempts'), { target: { value: '2' } });
    const download = screen.getByRole('link', { name: 'Download refit.yml' });
    const content = decodeURIComponent(download.getAttribute('href')!.split(',')[1]);
    expect(content).toContain('install: pnpm install --frozen-lockfile');
    expect(content).toContain('    - pnpm typecheck');
    expect(content).toContain('    - pnpm test');
    expect(content).not.toContain('pnpm lint');
    expect(content).toContain('maxAttempts: 2');
    expect(content).toContain('draftPullRequests: true');
    expect(download).toHaveAttribute('download', 'refit.yml');
  });

  it('prevents exporting a configuration without validation', () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    fireEvent.click(screen.getByRole('checkbox', { name: /Typecheck/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Lint/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tests/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Keep at least one validation check');
    expect(screen.getByRole('checkbox', { name: /Tests/ })).toBeChecked();
  });

  it('rejects invalid attempts and missing validation checks at the generation boundary', () => {
    expect(() => createConfiguration('npm', ['test'], 0)).toThrow(RangeError);
    expect(() => createConfiguration('npm', ['test'], 4)).toThrow(RangeError);
    expect(() => createConfiguration('npm', ['test'], 1.5)).toThrow(RangeError);
    expect(() => createConfiguration('npm', [], 2)).toThrow(TypeError);
  });
});
