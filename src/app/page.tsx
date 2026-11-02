// Placeholder home page. Deliberately shows no prices or client data:
// login and role checks arrive before any data screens are exposed.
export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "64px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 28 }}>NewGen AI Office</h1>
      <p>Quinn — AI Quotation Specialist</p>
      <p style={{ opacity: 0.7 }}>Phase 1: pricing catalogue and deterministic pricing engine. No screens yet.</p>
    </main>
  );
}
