import { cargarCache } from './db.config.js';
cargarCache().then(c => console.log(c.sensores.find((s: any) => s.inver_id === 'INV-01')));
