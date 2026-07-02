<script lang="ts">
  import { page } from "$app/state";
</script>

<svelte:head>
  <title>Not Found — On The Beach</title>
</svelte:head>

<main class="main">
  <div class="release-page">
    <p>
      {page.status === 404
        ? "Not found — this release doesn't exist."
        : (page.error?.message ?? "Something went wrong.")}
    </p>
    <a href="/" class="btn btn--ghost">◄</a>
  </div>
</main>
