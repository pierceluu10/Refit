import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Pricing } from './Pricing';

function plan(name: string) {
  const row = screen.getByRole('heading', { level: 2, name }).closest('li');
  expect(row, `${name} plan row`).not.toBeNull();
  return row!;
}

describe('pricing page', () => {
  it('states when billing starts', () => {
    render(<Pricing />, { wrapper: MemoryRouter });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Billing starts after your first merged fix.',
    );
  });

  it('lists exactly the three plans and their facts', () => {
    render(<Pricing />, { wrapper: MemoryRouter });
    expect(
      within(screen.getByRole('list', { name: 'Plans' }))
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Watch', 'Paid', 'Enterprise']);

    expect(plan('Watch')).toHaveTextContent('Free');
    expect(plan('Watch')).toHaveTextContent('Maps everything your code depends on and alerts you.');

    expect(plan('Paid')).toHaveTextContent('$319 a month');
    expect(plan('Paid')).toHaveTextContent('For up to 50 repos.');
    expect(plan('Paid')).toHaveTextContent('Then $5 per extra repo, up to 200.');

    expect(plan('Enterprise')).toHaveTextContent('Custom');
    expect(plan('Enterprise')).toHaveTextContent('Above 200 repos.');
    expect(plan('Enterprise')).toHaveTextContent('Private sandbox, audit trail, SSO.');
  });

  it('sends every plan to the waitlist on the homepage', () => {
    render(<Pricing />, { wrapper: MemoryRouter });
    for (const name of ['Watch', 'Paid', 'Enterprise']) {
      const link = within(plan(name)).getByRole('link');
      expect(link).toHaveTextContent('Join the waitlist');
      expect(link).toHaveAttribute('href', '/#top');
    }
  });

  it('invents no contact address', () => {
    const { container } = render(<Pricing />, { wrapper: MemoryRouter });
    expect(container.querySelector('main')!.textContent).not.toMatch(/@|contact/i);
  });
});
