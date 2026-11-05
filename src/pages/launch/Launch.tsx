import '@fontsource/doto/900.css';
import { useLayoutEffect, useRef } from 'react';
import css from './launch.css?inline';
import './launch-root.css';
import markup from './launch.html?raw';
import { startLaunchPage } from './page.js';

// The homepage. It sits in a shadow root because its class names (.hero, .nav, .footer, .code)
// are also used by the site's global styles, and its page script owns the scroll and the wheel.
export function Launch() {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = host.current!;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    shadow.replaceChildren(style);
    shadow.append(document.createRange().createContextualFragment(markup));

    const page = new AbortController();
    const html = document.documentElement;
    html.classList.add('launch-root');
    startLaunchPage(shadow, page.signal);
    return () => {
      page.abort();
      shadow.replaceChildren();
      html.classList.remove('launch-root');
      // index.html starts the homepage black; the other pages have their own backgrounds.
      html.style.background = '';
    };
  }, []);

  return <div id="main-content" ref={host} />;
}
