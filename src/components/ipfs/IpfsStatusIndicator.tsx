import { useState, useEffect, useCallback } from 'react';
import { Loader2, Database, ServerOff, Check, X, Settings, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';

type IpfsConnectionStatus = 'checking' | 'connected_local' | 'connected_public' | 'disconnected';

interface IpfsSettings {
  customEndpoint: string;
  useCustomEndpoint: boolean;
}

export function IpfsStatusIndicator() {
  const [status, setStatus] = useState<IpfsConnectionStatus>('checking');
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<IpfsSettings>(() => {
    const savedSettings = localStorage.getItem('ipfsSettings');
    return savedSettings ? JSON.parse(savedSettings) : {
      customEndpoint: 'http://localhost:5001',
      useCustomEndpoint: false
    };
  });
  const [tempSettings, setTempSettings] = useState<IpfsSettings>(settings);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Check IPFS connection on mount and when settings change
  useEffect(() => {
    checkIpfsConnection();
  }, []);
  
  // Save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('ipfsSettings', JSON.stringify(settings));
  }, [settings]);
  
  const checkIpfsConnection = useCallback(async (configToCheck: IpfsSettings = settings) => {
    setIsCheckingConnection(true);
    setStatus('checking');
    setErrorMessage(null);
    
    console.log('--- IPFS CONNECTION DEBUG ---');
    console.log('Starting IPFS connection check with settings:', JSON.stringify(configToCheck));
    
    try {
      // First try local node
      let connected = false;
      
      if (configToCheck.useCustomEndpoint) {
        // Try custom endpoint
        console.log(`Attempting to connect to custom IPFS endpoint: ${configToCheck.customEndpoint}`);
        connected = await tryConnectToIpfs(configToCheck.customEndpoint);
        console.log(`Custom endpoint connection result: ${connected ? 'SUCCESS' : 'FAILED'}`);
        
        if (connected) {
          setStatus('connected_local');
          console.log('Successfully connected to custom IPFS endpoint');
        } else {
          console.error(`Failed to connect to custom endpoint: ${configToCheck.customEndpoint}`);
          throw new Error(`Cannot connect to custom endpoint: ${configToCheck.customEndpoint}`);
        }
      } else {
        // Try default local node
        console.log('Attempting to connect to local IPFS node at http://localhost:5001');
        connected = await tryConnectToIpfs('http://localhost:5001');
        console.log(`Local node connection result: ${connected ? 'SUCCESS' : 'FAILED'}`);
        
        if (connected) {
          setStatus('connected_local');
          console.log('Successfully connected to local IPFS node');
        } else {
          console.log('Local node connection failed, trying public gateway...');
          // Fallback to public gateway
          console.log('Attempting to connect to public IPFS gateway at https://ipfs.io');
          connected = await tryConnectToIpfs('https://ipfs.io');
          console.log(`Public gateway connection result: ${connected ? 'SUCCESS' : 'FAILED'}`);
          
          if (connected) {
            setStatus('connected_public');
            console.log('Successfully connected to public IPFS gateway');
          } else {
            // Try one more time with a CORS proxy for public gateway
            console.log('Public gateway direct connection failed, trying with CORS proxy...');
            connected = await tryConnectToIpfs('https://ipfs.io', true);
            console.log(`Public gateway with CORS proxy result: ${connected ? 'SUCCESS' : 'FAILED'}`);
            
            if (connected) {
              setStatus('connected_public');
              console.log('Successfully connected to public IPFS gateway via CORS proxy');
            } else {
              setStatus('disconnected');
              console.error('Failed to connect to both local IPFS node and public gateway (with and without CORS proxy)');
              throw new Error('Cannot connect to IPFS local node or public gateway');
            }
          }
        }
      }
    } catch (error) {
      console.error('IPFS connection error:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Unknown connection error');
      if (status !== 'connected_public') {
        setStatus('disconnected');
      }
    } finally {
      setIsCheckingConnection(false);
      console.log(`Final connection status: ${status}`);
      console.log('--- END IPFS CONNECTION DEBUG ---');
    }
  }, [settings, status]);
  
  const tryConnectToIpfs = async (endpoint: string, useCorsProxy = false): Promise<boolean> => {
    console.log(`IPFS: Attempting connection to ${endpoint}${useCorsProxy ? ' (with CORS proxy)' : ''}`);
    try {
      // First do a basic check if the host is reachable at all
      const baseUrl = new URL(endpoint).origin;
      console.log(`IPFS: Testing if base URL is reachable: ${baseUrl}`);
      
      try {
        // Try a HEAD request to the base URL first (lighter than a full GET)
        const headCheck = await fetch(baseUrl, { 
          method: 'HEAD',
          mode: 'no-cors', // This allows us to at least check reachability even with CORS issues
          cache: 'no-cache',
          headers: { 'Cache-Control': 'no-cache' },
          redirect: 'follow',
          signal: AbortSignal.timeout(2000) // 2 second timeout for the HEAD check
        });
        
        console.log(`IPFS: Base URL ${baseUrl} HEAD check result:`, {
          status: headCheck.status,
          statusText: headCheck.statusText,
          type: headCheck.type // 'opaque' for no-cors responses
        });
      } catch (headError) {
        // If we can't even reach the base URL, log and continue to the full API check anyway
        console.warn(`IPFS: Base URL ${baseUrl} is not reachable:`, headError instanceof Error ? headError.message : String(headError));
        // We still try the API call as sometimes the base URL might refuse HEAD but accept the API call
      }
      
      // For a real implementation, use proper IPFS client library
      // For now, just simulate connection check with a fetch to the API endpoint
      let url = endpoint.includes('/api/') 
        ? `${endpoint}/version` 
        : `${endpoint}/api/v0/version`;
      
      // If using CORS proxy, wrap the URL with a public CORS proxy service
      if (useCorsProxy) {
        // Note: this is for testing only - in production you'd want your own proxy
        url = `https://corsproxy.io/?${encodeURIComponent(url)}`;
        console.log(`IPFS: Using CORS proxy: ${url}`);
      }
      
      console.log(`IPFS: Constructed API URL: ${url}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`IPFS: Connection attempt to ${url} timed out after 3000ms`);
        controller.abort();
      }, 3000);
      
      console.log(`IPFS: Sending POST request to ${url}`);
      const response = await fetch(url, { 
        signal: controller.signal,
        method: 'POST', // IPFS API uses POST
        headers: useCorsProxy ? { 'Content-Type': 'application/json' } : undefined
      });
      
      clearTimeout(timeoutId);
      
      console.log(`IPFS: Response from ${url}:`, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries([...response.headers.entries()]),
        ok: response.ok
      });
      
      // For debugging, try to get response body
      try {
        const responseText = await response.text();
        console.log(`IPFS: Response body from ${url}:`, responseText.substring(0, 200) + (responseText.length > 200 ? '...' : ''));
      } catch (bodyError) {
        console.log(`IPFS: Could not read response body: ${bodyError}`);
      }
      
      return response.ok;
    } catch (error) {
      console.error(`IPFS connection attempt failed for ${endpoint}:`, error);
      // More details about the error
      if (error instanceof TypeError) {
        console.error(`IPFS: Network error - this often means CORS issues, the endpoint doesn't exist, or network problems`);
      } else if (error instanceof DOMException && error.name === 'AbortError') {
        console.error(`IPFS: Request was aborted due to timeout`);
      } else if (error instanceof Error) {
        console.error(`IPFS: Error type: ${error.name}, message: ${error.message}`);
      } else {
        console.error(`IPFS: Unknown error type`);
      }
      return false;
    }
  };
  
  const applySettings = () => {
    setSettings(tempSettings);
    checkIpfsConnection(tempSettings);
    setShowSettings(false);
  };
  
  const cancelSettings = () => {
    setTempSettings(settings);
    setShowSettings(false);
  };
  
  const renderStatusIcon = () => {
    switch (status) {
      case 'checking':
        return <Loader2 size={12} className="mr-1 animate-spin text-yellow-600 dark:text-yellow-400" />;
      case 'connected_local':
        return <Database size={12} className="mr-1 text-green-600 dark:text-green-400" />;
      case 'connected_public':
        return <ExternalLink size={12} className="mr-1 text-blue-600 dark:text-blue-400" />;
      case 'disconnected':
        return <ServerOff size={12} className="mr-1 text-red-600 dark:text-red-400" />;
    }
  };
  
  const getStatusLabel = () => {
    switch (status) {
      case 'checking':
        return 'Checking IPFS...';
      case 'connected_local':
        return 'IPFS Local';
      case 'connected_public':
        return 'IPFS Gateway';
      case 'disconnected':
        return 'IPFS Offline';
    }
  };
  
  return (
    <div className="relative">
      <div 
        className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1 cursor-pointer"
        onClick={() => setShowSettings(true)}
      >
        <div className="flex items-center text-xs">
          {renderStatusIcon()}
          <span className={`
            ${status === 'connected_local' ? 'text-green-600 dark:text-green-400' : ''}
            ${status === 'connected_public' ? 'text-blue-600 dark:text-blue-400' : ''}
            ${status === 'disconnected' ? 'text-red-600 dark:text-red-400' : ''}
            ${status === 'checking' ? 'text-yellow-600 dark:text-yellow-400' : ''}
          `}>
            {getStatusLabel()}
          </span>
        </div>
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-6 w-6 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
        >
          <Settings size={12} />
        </Button>
      </div>
      
      {showSettings && (
        <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-800 rounded-md shadow-lg p-3 w-72 z-10">
          <h3 className="text-sm font-medium mb-2 dark:text-gray-200">IPFS Connection Settings</h3>
          
          <div className="mb-3">
            <label className="flex items-center space-x-2 text-xs mb-1 dark:text-gray-300">
              <input
                type="checkbox"
                checked={tempSettings.useCustomEndpoint}
                onChange={(e) => setTempSettings({...tempSettings, useCustomEndpoint: e.target.checked})}
                className="rounded border-gray-300 dark:border-gray-600 text-yellow-400 focus:ring-yellow-400"
              />
              <span>Use custom IPFS endpoint</span>
            </label>
            
            <input
              type="text"
              value={tempSettings.customEndpoint}
              onChange={(e) => setTempSettings({...tempSettings, customEndpoint: e.target.value})}
              disabled={!tempSettings.useCustomEndpoint}
              placeholder="e.g., http://localhost:5001"
              className="w-full text-xs p-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
            />
          </div>
          
          {errorMessage && (
            <p className="text-xs text-red-600 dark:text-red-400 mb-2">{errorMessage}</p>
          )}
          
          <div className="flex justify-end space-x-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={cancelSettings}
              className="text-xs"
            >
              <X size={12} className="mr-1" />
              Cancel
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => checkIpfsConnection(tempSettings)}
              disabled={isCheckingConnection}
              className="text-xs"
            >
              {isCheckingConnection ? 
                <Loader2 size={12} className="mr-1 animate-spin" /> : 
                <Database size={12} className="mr-1" />
              }
              Test Connection
            </Button>
            <Button 
              variant="default" 
              size="sm" 
              onClick={applySettings}
              className="text-xs bg-yellow-400 hover:bg-yellow-500 text-black"
            >
              <Check size={12} className="mr-1" />
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
} 