import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';

const headlines = {
  harbor: 'Your APIs change.',
  premiere: 'Refit fixed it.',
  studio: 'Watch Refit fix an API change.',
  dial: 'Always watching',
  kinetic: 'Refit fixed it.',
  session: 'Your code keeps up.',
  manual: 'API change in. Pull request out.',
  specimen: 'Your API changed. Here’s the pull request.',
  receipt: 'Every migration comes with a receipt.',
  transit: 'Every API your code calls, on one map.',
};

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('design directions', () => {
  it.each(Object.entries(headlines))(
    'renders the %s direction with a signup and the demo',
    async (slug, headline) => {
      renderAt(`/directions/${slug}`);
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(headline);
      expect(screen.getAllByLabelText('Work email').length).toBeGreaterThan(0);
      // Premiere tells the demo as six step windows instead of one film.
      if (slug === 'premiere') {
        const steps = screen.getByRole('list', { name: 'How Refit works, step by step' });
        expect(steps.children).toHaveLength(6);
        expect(steps).toHaveTextContent('Your coding agent explains it to you.');
      } else {
        expect(
          screen.getByRole('region', { name: 'Illustrative demo: Refit fixes a Slack API change' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^(Play|Pause) the demo$/ })).toBeInTheDocument();
      }
    },
  );

  it('offers a button for every step of the film', async () => {
    renderAt('/directions/harbor');
    await screen.findByRole('heading', { level: 1 });
    for (const step of ['Change', 'Find', 'Fix', 'Prove', 'Ship', 'Brief'])
      expect(screen.getByRole('button', { name: step })).toBeInTheDocument();
  });

  it('sends /directions and unknown names to the first direction', async () => {
    renderAt('/directions/nope');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(headlines.harbor);
  });
});
