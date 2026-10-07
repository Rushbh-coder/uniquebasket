// Runs before `npm run dist`. v3: NOTHING secret is bundled into the installer any more.
// (v2 copied the MongoDB password into shop-config.json inside the .exe — that file is now emptied.)
const fs = require('fs');
fs.writeFileSync('shop-config.json', '{}');
console.log('Installer contains no database credentials. Set up the manager PC with PC Setup; counters enrol with a code.');
