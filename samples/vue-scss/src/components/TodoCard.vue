<template>
  <div class="todo-card surface surface--raised" :class="{ 'todo-card--done': done, 'is-': urgent }">
    <h3 class="todo-card__title">{{ title }}</h3>
    <span class="badge" :class="done ? 'is-success' : 'is-danger'">{{ done ? 'Done' : 'Open' }}</span>
    <p :class="[$style.note, 'todo-card__']">{{ note }}</p>
  </div>
</template>

<script setup>
defineProps({ title: String, note: String, done: Boolean, urgent: Boolean });
</script>

<style scoped lang="scss">
.todo-card {
  padding: 16px;
  &__title { margin: 0 0 6px; font-size: 1rem; }
  &__meta { color: #6b7280; font-size: .875rem; }
  &--done &__title { text-decoration: line-through; }
}
</style>

<style module>
.note { font-style: italic; }
.noteWarning { color: #b45309; }
</style>
