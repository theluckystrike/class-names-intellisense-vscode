import './app.css';
import { cn } from './lib/utils';
import { Button } from './Button';

export default function App({ dense }) {
  return (
    <div className={cn('app-shell', dense && '')}>
      <div className={`toolbar ${dense ? 'toolbar-dense' : ''}`}>
        <Button>Save</Button>
        <span className="toolbar-spacer" />
      </div>
    </div>
  );
}
