<script lang="ts">
  import ReleasePage from "$lib/components/ReleasePage.svelte";

  let { data } = $props();
</script>

{#key data.item.id}
  <ReleasePage {data} />
{/key}
