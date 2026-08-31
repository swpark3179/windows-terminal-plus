import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/app.css';

// StrictMode 는 개발 모드에서 이펙트를 두 번 실행한다. 터미널 패널의 이펙트는
// 실제 셸 프로세스를 띄우므로, 여기서는 켜지 않는다.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
