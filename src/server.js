const express = require('express');
const cors = require('cors');
const config = require('./config');
const productStore = require('./productStore');
const sessionStore = require('./sessionStore');
const recommendRoutes = require('./routes/recommend');
const engine = require('./engines');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api', recommendRoutes);

app.listen(config.port, () => {
  console.log(`Product recommendation agent listening on port ${config.port}`);
  console.log(`Engine mode: ${engine.engineInUse.toUpperCase()}${engine.engineInUse === 'rule' ? ' (set ANTHROPIC_API_KEY to switch to LLM mode)' : ''}`);
  productStore.startAutoRefresh();
  sessionStore.startSweeper();
});
