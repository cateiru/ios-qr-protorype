import QrScanner from './components/QrScanner/QrScanner'
import './App.css'

function App() {
  return (
    <div className="page">
      <QrScanner />
      <p className="page__hint">
        実際のカメラでQRコードを読み取ります。初回アクセス時はカメラへのアクセスを許可してください。
      </p>
    </div>
  )
}

export default App
