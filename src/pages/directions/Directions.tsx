import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { Dial } from './Dial';
import { Harbor } from './Harbor';
import { Kinetic } from './Kinetic';
import { Manual } from './Manual';
import { Premiere } from './Premiere';
import { Receipt } from './Receipt';
import { Session } from './Session';
import { Specimen } from './Specimen';
import { Studio } from './Studio';
import { Transit } from './Transit';

const directions = [
  { slug: 'harbor', name: 'Harbor', Page: Harbor },
  { slug: 'premiere', name: 'Premiere', Page: Premiere },
  { slug: 'studio', name: 'Studio', Page: Studio },
  { slug: 'dial', name: 'Dial', Page: Dial },
  { slug: 'kinetic', name: 'Kinetic', Page: Kinetic },
  { slug: 'session', name: 'Session', Page: Session },
  { slug: 'manual', name: 'Manual', Page: Manual },
  { slug: 'specimen', name: 'Specimen', Page: Specimen },
  { slug: 'receipt', name: 'Receipt', Page: Receipt },
  { slug: 'transit', name: 'Transit', Page: Transit },
];

// Ten homepage directions for Refit, one per /directions/<slug>.
export function Directions() {
  const { slug } = useParams();
  const direction = directions.find((entry) => entry.slug === slug);
  useEffect(() => {
    if (direction) document.title = `Refit: ${direction.name} direction`;
  }, [direction]);
  if (!direction) return <Navigate replace to="/directions/harbor" />;
  const { Page } = direction;
  return <Page />;
}
