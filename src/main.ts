import { initialize } from "./app";

async function bootstrap() {
  try {
    await initialize();
    console.log("[App] Initialized successfully");
  } catch (error) {
    console.error("[App] Failed to initialize:", error);
    document.body.innerHTML = `
      <div class="error-screen">
        <h1>Failed to load</h1>
        <p>Could not connect to the server. Please try again.</p>
        <pre>${error}</pre>
      </div>
    `;
  }
}

bootstrap();
