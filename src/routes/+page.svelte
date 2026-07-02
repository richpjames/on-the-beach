<script lang="ts">
  import MainPage from "$lib/components/MainPage.svelte";

  let { data } = $props();
</script>

<MainPage {data} />
