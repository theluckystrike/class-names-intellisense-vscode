<script>
  export let items = [];
  export let current = '';
  let open = false;
</script>

<nav class="nav" class:nav--open={open}>
  <button class="nav__toggle" on:click={() => (open = !open)}>Menu</button>
  <ul class="nav__list">
    {#each items as item}
      <li class="nav__item" class:is-current={item.href === current}>
        <a class="nav__link " href={item.href}>{item.label}</a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .nav { display: flex; align-items: center; justify-content: space-between; }
  .nav--open .nav__list { display: block; }
  .nav__toggle { display: none; }
  .nav__list { display: flex; gap: 16px; list-style: none; margin: 0; padding: 0; }
  .nav__link { color: inherit; }
  .nav__link--muted { opacity: .7; }
  .is-current .nav__link { font-weight: 700; }
  @media (max-width: 640px) { .nav__toggle { display: block; } .nav__list { display: none; } }
</style>
