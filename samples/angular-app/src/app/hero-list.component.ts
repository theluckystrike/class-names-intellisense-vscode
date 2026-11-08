import { Component } from '@angular/core';

@Component({
  selector: 'app-hero-list',
  templateUrl: './hero-list.component.html',
  styleUrls: ['./hero-list.component.scss'],
})
export class HeroListComponent {
  heroes = [{ id: 11, name: 'Dr. Nice', retired: false }];
  selected?: { id: number; name: string };
  select(h: { id: number; name: string }) { this.selected = h; }
}
