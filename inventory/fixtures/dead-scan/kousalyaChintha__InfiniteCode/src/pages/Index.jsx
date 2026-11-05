// Excerpt of kousalyaChintha/InfiniteCode, src/pages/Index.jsx, seen in P5.
import { useState } from 'react';
import LeftPanel from '../components/LeftPanel';

export default function Index() {
  const [aiSettings] = useState({
    provider: localStorage.getItem('ai_provider') || 'openai',
    model: localStorage.getItem('ai_model') || 'gpt-4',
  });
  return <LeftPanel aiSettings={aiSettings} />;
}
