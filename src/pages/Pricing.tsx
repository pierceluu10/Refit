import { Link } from 'react-router-dom';
import { Footer, Header } from '../components/Layout';
import './pricing.css';

const PAID_MONTHLY_PRICE = 319;
const PAID_INCLUDED_REPOS = 50;
const EXTRA_REPO_PRICE = 5;
const PAID_MAX_REPOS = 200;
const WAITLIST_PATH = '/#top';

const plans = [
  {
    name: 'Watch',
    price: 'Free',
    terms: ['Maps everything your code depends on and alerts you.'],
    action: 'button-secondary',
  },
  {
    name: 'Paid',
    price: `$${PAID_MONTHLY_PRICE} a month`,
    terms: [
      `For up to ${PAID_INCLUDED_REPOS} repos.`,
      `Then $${EXTRA_REPO_PRICE} per extra repo, up to ${PAID_MAX_REPOS}.`,
    ],
    action: 'button-primary',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    terms: [`Above ${PAID_MAX_REPOS} repos.`, 'Private sandbox, audit trail, SSO.'],
    action: 'button-secondary',
  },
];

export function Pricing() {
  return (
    <>
      <Header />
      <main id="main-content" className="pricing content-width">
        <h1>Billing starts after your first merged fix.</h1>
        <ul className="pricing-plans" aria-label="Plans">
          {plans.map((plan) => (
            <li key={plan.name} className="pricing-plan">
              <h2>{plan.name}</h2>
              <p className="pricing-price">{plan.price}</p>
              <div className="pricing-terms">
                {plan.terms.map((term) => (
                  <p key={term}>{term}</p>
                ))}
              </div>
              <Link
                className={`button ${plan.action}`}
                to={WAITLIST_PATH}
                aria-label={`Join the waitlist for ${plan.name}`}
              >
                Join the waitlist
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </>
  );
}
