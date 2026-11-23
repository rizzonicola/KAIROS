import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("missing #app root");
}

app.innerHTML = `
  <main class="shell">
    <header class="masthead">
      <h1>KAIROS <span>Web Lite</span></h1>
      <p class="tagline">A personality around Stockfish 19 Lite, running entirely in your browser.</p>
    </header>
    <section class="panel">
      <p>Loading the board and engine…</p>
    </section>
  </main>
`;
