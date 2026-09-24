import Link from "next/link";

export default function Home() {
  return (
    <div className="relative">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-orange-500/10 via-transparent to-yellow-500/5"></div>
        
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-24 relative">
          <div className="text-center max-w-3xl mx-auto">
            <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6">
              <span className="bg-gradient-to-r from-orange-400 via-yellow-400 to-orange-400 bg-clip-text text-transparent">
                Crypto Charts
              </span>
              <br />
              <span className="text-white">Made Simple</span>
            </h1>
            
            <p className="text-xl text-gray-400 mb-10 leading-relaxed">
              Professional TradingView charts for Bitcoin, Ethereum, and hundreds of cryptocurrencies. 
              Free access for everyone. No complicated tools — just clean, powerful charts.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center px-8 py-4 text-lg font-semibold rounded-xl bg-gradient-to-r from-orange-500 to-yellow-500 text-black hover:from-orange-400 hover:to-yellow-400 transition shadow-lg shadow-orange-500/25"
              >
                Open Live Charts
              </Link>
              <a
                href="#features"
                className="inline-flex items-center justify-center px-8 py-4 text-lg font-semibold rounded-xl border border-gray-700 text-white hover:bg-gray-800 transition"
              >
                Learn More
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-center mb-12">Why Alarm Chert?</h2>
          
          <div className="grid md:grid-cols-3 gap-8">
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-8 hover:border-orange-500/50 transition">
              <div className="w-12 h-12 bg-orange-500/20 rounded-xl flex items-center justify-center mb-5">
                <span className="text-2xl">📈</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">Professional Charts</h3>
              <p className="text-gray-400">
                Full TradingView Advanced Charts with indicators, drawing tools, and multiple timeframes.
              </p>
            </div>
            
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-8 hover:border-orange-500/50 transition">
              <div className="w-12 h-12 bg-orange-500/20 rounded-xl flex items-center justify-center mb-5">
                <span className="text-2xl">🪙</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">Crypto Focused</h3>
              <p className="text-gray-400">
                Optimized for Bitcoin, Ethereum, Solana, and all major cryptocurrencies.
              </p>
            </div>
            
            <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-8 hover:border-orange-500/50 transition">
              <div className="w-12 h-12 bg-orange-500/20 rounded-xl flex items-center justify-center mb-5">
                <span className="text-2xl">🔓</span>
              </div>
              <h3 className="text-xl font-semibold mb-3">100% Free</h3>
              <p className="text-gray-400">
                No subscription required. Create a free account and start analyzing markets immediately.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to start?</h2>
          <p className="text-gray-400 mb-8">
            Jump into the live charts right now. No registration needed for basic access.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center px-8 py-4 text-lg font-semibold rounded-xl bg-orange-500 hover:bg-orange-600 text-white transition"
          >
            Go to Charts →
          </Link>
        </div>
      </section>
    </div>
  );
}
