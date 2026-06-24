# Kaziranga Profit Tracker v2

A React-based profit tracking application for the Kaziranga Cricket Store, built with Vite and deployed on Vercel.

## Features

- **Daily Sales Tracking**: Log daily revenue and costs
- **Bulk Orders**: Manage bulk orders with detailed cost breakdown
- **CSV Import**: Import data from Square CSV exports
- **Monthly Analytics**: View monthly trends and profitability
- **Category Breakdown**: Analyze profit by product category
- **Charts**: Visual representations of revenue, cost, and profit trends
- **Local Storage**: All data persists in browser storage

## Getting Started

### Prerequisites
- Node.js 16+ and npm/yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Opens http://localhost:3000 in your browser.

### Build for Production

```bash
npm run build
```

Creates optimized build in the `dist/` folder.

### Deployment to Vercel

The project is configured for automatic deployment on Vercel:

1. Push your repository to GitHub
2. Import the project in Vercel: https://vercel.com/new
3. Vercel will automatically detect the Vite configuration and build settings
4. Your app will be live in seconds!

Or deploy directly via Vercel CLI:

```bash
npm i -g vercel
vercel
```

## Project Structure

```
kaziranga-profit-tracker/
├── src/
│   ├── App.jsx           # Main React component
│   └── main.jsx          # React DOM entry point
├── index.html            # HTML template
├── vite.config.js        # Vite configuration
├── vercel.json           # Vercel deployment config
├── package.json          # Dependencies
└── README.md             # This file
```

## Data Format

### CSV Import Format

Expected columns in your Square CSV export:
- Date (MM/DD/YYYY format)
- Item
- Category
- Qty
- Item Cost
- Gross Sales
- Net Sales
- Net Profit
- Tax
- Customer
- Repeat
- Sales Channel

## Technologies

- **React 18**: UI framework
- **Vite**: Build tool and dev server
- **Recharts**: Chart components
- **Vercel**: Hosting platform

## License

Private - Kaziranga Cricket Store
