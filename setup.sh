#!/bin/bash

echo "🚀 Setting up Adyen Sessions Flow Demo..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18 or later."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Create directories
echo "📁 Creating directories..."
mkdir -p backend frontend logs

# Install backend dependencies
echo "📦 Installing backend dependencies..."
cd backend
npm install

# Install frontend dependencies
echo "📦 Installing frontend dependencies..."
cd ../frontend
npm install

# Create .env file if it doesn't exist
cd ../backend
if [ ! -f .env ]; then
    echo "🔧 Creating .env file from template..."
    cp .env.example .env
    echo "⚠️  Please edit backend/.env with your Adyen credentials before running the demo."
fi

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Edit backend/.env with your Adyen credentials"
echo "2. Start backend: cd backend && npm start"
echo "3. Start frontend: cd frontend && npm start"
echo "4. Open http://localhost:8080 in your browser"
echo ""
echo "📚 See README.md for detailed documentation"