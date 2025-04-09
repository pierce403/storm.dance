# storm.dance

A minimalist note-taking application with Markdown support and local storage.

## Overview

storm.dance is a web-based note-taking application built with React and Tailwind CSS. It provides a clean, intuitive interface for creating, editing, and managing notes with Markdown support.

## Features

- Create, edit, and delete notes
- Markdown editing and preview
- Persistent storage using IndexedDB
- Clean, minimal UI inspired by Obsidian and Joplin
- Responsive design

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/storm-dance.git

# Navigate to the project directory
cd storm-dance

# Install dependencies
npm install
```

## Development

To run the application in development mode:

```bash
npm run dev
```

This will start the development server at [http://localhost:5173](http://localhost:5173).

## Building for Production

To build the application for production:

```bash
npm run build
```

This will create a `dist` directory with the compiled assets ready for deployment.

## Deployment

You can deploy the built application to any static hosting service:

1. Build the application as described above
2. Upload the contents of the `dist` directory to your hosting service
3. Configure your hosting service to serve the application (if necessary)

Popular hosting options include:
- GitHub Pages
- Netlify
- Vercel
- Firebase Hosting

## Future Architecture

This MVP is the first step towards a more complex, decentralized application. Future versions will incorporate:

- Client-side encryption of all note data
- Integration with Ethereum wallets for user identity
- Decentralized storage using IPFS
- Real-time collaboration features using CRDTs (like Yjs or Automerge)
- Synchronization and communication via a web3 messaging protocol like XMTP

The current codebase is structured with modularity in mind, particularly around data persistence and state management, to facilitate these future enhancements.

## Project Structure

```
storm-dance/
├── public/            # Static assets
├── src/
│   ├── assets/        # Images, fonts, etc.
│   ├── components/    # React components
│   │   └── notes/     # Note-related components
│   ├── lib/           # Utilities and services
│   │   ├── db/        # Database service
│   │   └── hooks/     # Custom React hooks
│   ├── App.tsx        # Main application component
│   └── main.tsx       # Application entry point
└── index.html         # HTML template
```

## License

MIT
