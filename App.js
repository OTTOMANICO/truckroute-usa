import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, ScrollView, Alert, Dimensions, Platform, SafeAreaView, ActivityIndicator, Modal } from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import axios from 'axios';

const { width, height } = Dimensions.get('window');

// Backend API URL
const API_URL = 'https://turkce-sorulan.preview.emergentagent.com/api';

// OpenRouteService API (Free tier)
const ORS_API_KEY = '5b3ce3597851110001cf6248a8b8a8a8a8b8a8a8'; // Will use backend proxy

// Colors
const COLORS = {
  primary: '#3b82f6',
  secondary: '#1e293b',
  background: '#0f172a',
  card: '#1e293b',
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  success: '#22c55e',
  danger: '#ef4444',
  warning: '#eab308',
};

export default function App() {
  const [activeTab, setActiveTab] = useState('map');
  const [truckStops, setTruckStops] = useState([]);
  const [restrictions, setRestrictions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [userLocation, setUserLocation] = useState(null);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [startAddress, setStartAddress] = useState('');
  const [endAddress, setEndAddress] = useState('');
  const [selectingPoint, setSelectingPoint] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null);
  const [directions, setDirections] = useState([]);
  const [showDirections, setShowDirections] = useState(false);
  const [calculatingRoute, setCalculatingRoute] = useState(false);
  const [showFilters, setShowFilters] = useState({ fuel: true, rest: true, parking: true, weigh: false, restrictions: true });
  const [truckProfile, setTruckProfile] = useState({
    height_feet: 13.5,
    weight_lbs: 80000,
    width_feet: 8.5,
    length_feet: 75,
    hazmat: false
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchingFor, setSearchingFor] = useState(null); // 'start' or 'end'
  const webViewRef = useRef(null);

  useEffect(() => {
    initializeApp();
  }, []);

  const initializeApp = async () => {
    try {
      setLoading(true);
      
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        let location = await Location.getCurrentPositionAsync({});
        setUserLocation({
          lat: location.coords.latitude,
          lng: location.coords.longitude,
        });
      }

      await axios.post(`${API_URL}/seed-data`).catch(() => {});
      
      const [stopsRes, restrictionsRes] = await Promise.all([
        axios.get(`${API_URL}/truck-stops`).catch(() => ({ data: [] })),
        axios.get(`${API_URL}/restrictions`).catch(() => ({ data: [] }))
      ]);
      
      setTruckStops(stopsRes.data || []);
      setRestrictions(restrictionsRes.data || []);
    } catch (err) {
      console.log('Init error:', err.message);
    } finally {
      setLoading(false);
    }
  };

  // Search for address
  const searchAddress = async (query) => {
    if (query.length < 3) {
      setSearchResults([]);
      return;
    }
    try {
      const response = await axios.get(`${API_URL}/geocode`, { params: { address: query } });
      setSearchResults(response.data.results || []);
    } catch (error) {
      console.log('Search error:', error);
    }
  };

  // Select search result
  const selectAddress = (result) => {
    const point = { lat: result.lat, lng: result.lng };
    if (searchingFor === 'start') {
      setStartPoint(point);
      setStartAddress(result.address);
      sendToWebView('setStart', point);
    } else if (searchingFor === 'end') {
      setEndPoint(point);
      setEndAddress(result.address);
      sendToWebView('setEnd', point);
    }
    setSearchResults([]);
    setSearchQuery('');
    setSearchingFor(null);
  };

  // Send data to WebView
  const sendToWebView = (type, data) => {
    if (webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ type, data }));
    }
  };

  // Update map when data changes
  useEffect(() => {
    if (!loading) {
      setTimeout(() => {
        sendToWebView('updateStops', truckStops.filter(s => 
          (s.type === 'fuel' && showFilters.fuel) ||
          (s.type === 'rest' && showFilters.rest) ||
          (s.type === 'parking' && showFilters.parking) ||
          (s.type === 'weigh_station' && showFilters.weigh)
        ));
        sendToWebView('updateRestrictions', showFilters.restrictions ? restrictions : []);
        if (userLocation) {
          sendToWebView('setUserLocation', userLocation);
        }
      }, 1000);
    }
  }, [loading, truckStops, restrictions, showFilters, userLocation]);

  // Handle messages from WebView
  const handleWebViewMessage = (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      if (message.type === 'mapClick') {
        const { lat, lng } = message.data;
        if (selectingPoint === 'start') {
          setStartPoint({ lat, lng });
          setStartAddress(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          sendToWebView('setStart', { lat, lng });
          setSelectingPoint(null);
        } else if (selectingPoint === 'end') {
          setEndPoint({ lat, lng });
          setEndAddress(`${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          sendToWebView('setEnd', { lat, lng });
          setSelectingPoint(null);
        }
      }
    } catch (e) {
      console.log('Message parse error:', e);
    }
  };

  // Calculate real route using OpenRouteService
  const calculateRoute = async () => {
    if (!startPoint || !endPoint) {
      Alert.alert('Uyari', 'Lutfen baslangic ve bitis noktalarini secin');
      return;
    }
    
    setCalculatingRoute(true);
    
    try {
      // Call backend API for truck route
      const response = await axios.post(`${API_URL}/calculate-route`, {
        start_lat: startPoint.lat,
        start_lng: startPoint.lng,
        end_lat: endPoint.lat,
        end_lng: endPoint.lng
      });

      if (response.data.success && response.data.route?.routes?.[0]) {
        const route = response.data.route.routes[0];
        const geometry = route.geometry;
        const summary = route.summary;
        const segments = route.segments?.[0];
        
        // Decode polyline and send to map
        let routeCoords = [];
        if (typeof geometry === 'string') {
          routeCoords = decodePolyline(geometry);
        } else if (geometry?.coordinates) {
          routeCoords = geometry.coordinates.map(c => [c[1], c[0]]);
        }
        
        // Send route to WebView
        sendToWebView('drawRoute', routeCoords);
        
        // Set route info
        setRouteInfo({
          distance: (summary.distance).toFixed(1),
          duration: (summary.duration / 3600).toFixed(1)
        });
        
        // Get turn-by-turn directions
        if (segments?.steps) {
          const dirs = segments.steps.map((step, idx) => ({
            id: idx,
            instruction: step.instruction,
            distance: (step.distance).toFixed(1),
            duration: Math.round(step.duration / 60),
            type: step.type
          }));
          setDirections(dirs);
        }
      } else {
        // Fallback to direct calculation via ORS API
        await calculateRouteDirect();
      }
    } catch (error) {
      console.log('Route API error:', error);
      await calculateRouteDirect();
    }
    
    setCalculatingRoute(false);
  };

  // Direct ORS API call as fallback
  const calculateRouteDirect = async () => {
    try {
      const url = 'https://api.openrouteservice.org/v2/directions/driving-hgv';
      const response = await axios.post(url, {
        coordinates: [[startPoint.lng, startPoint.lat], [endPoint.lng, endPoint.lat]],
        instructions: true,
        units: 'mi'
      }, {
        headers: {
          'Authorization': '5b3ce3597851110001cf6248d3f5e8b7b8c9a0b1c2d3e4f5',
          'Content-Type': 'application/json'
        }
      });

      if (response.data?.routes?.[0]) {
        const route = response.data.routes[0];
        let routeCoords = [];
        
        if (typeof route.geometry === 'string') {
          routeCoords = decodePolyline(route.geometry);
        }
        
        sendToWebView('drawRoute', routeCoords);
        
        setRouteInfo({
          distance: route.summary.distance.toFixed(1),
          duration: (route.summary.duration / 3600).toFixed(1)
        });

        if (route.segments?.[0]?.steps) {
          const dirs = route.segments[0].steps.map((step, idx) => ({
            id: idx,
            instruction: step.instruction,
            distance: step.distance.toFixed(1),
            duration: Math.round(step.duration / 60),
            type: step.type
          }));
          setDirections(dirs);
        }
      }
    } catch (error) {
      console.log('Direct ORS error:', error);
      // Ultimate fallback - straight line
      sendToWebView('drawRoute', [[startPoint.lat, startPoint.lng], [endPoint.lat, endPoint.lng]]);
      
      const dist = haversineDistance(startPoint.lat, startPoint.lng, endPoint.lat, endPoint.lng);
      setRouteInfo({
        distance: dist.toFixed(1),
        duration: (dist / 55).toFixed(1),
        fallback: true
      });
      setDirections([{ id: 0, instruction: 'Dogrudan hedefe gidin', distance: dist.toFixed(1), duration: Math.round(dist / 55 * 60) }]);
    }
  };

  // Haversine distance calculation
  const haversineDistance = (lat1, lon1, lat2, lon2) => {
    const R = 3956;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // Decode polyline
  const decodePolyline = (encoded) => {
    const coords = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lat += dlat;
      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lng += dlng;
      coords.push([lat / 1e5, lng / 1e5]);
    }
    return coords;
  };

  // Clear route
  const clearRoute = () => {
    setStartPoint(null);
    setEndPoint(null);
    setStartAddress('');
    setEndAddress('');
    setRouteInfo(null);
    setDirections([]);
    sendToWebView('clearRoute', {});
  };

  // Get direction icon
  const getDirectionIcon = (type) => {
    const icons = {
      0: '🚗', 1: '⬆️', 2: '↗️', 3: '➡️', 4: '↘️', 5: '⬇️', 6: '↙️', 7: '⬅️', 8: '↖️',
      9: '🔄', 10: '🔄', 11: '🏁', 12: '🚏', 13: '🔀'
    };
    return icons[type] || '➡️';
  };

  // Generate map HTML with real routing support
  const getMapHTML = () => `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #map { width: 100%; height: 100%; }
    .custom-marker {
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%; border: 3px solid white;
      box-shadow: 0 3px 8px rgba(0,0,0,0.4); font-size: 16px; font-weight: bold;
    }
    .leaflet-popup-content { font-size: 13px; }
    .popup-title { font-weight: bold; margin-bottom: 5px; color: #1e293b; }
    .route-line { stroke-linecap: round; stroke-linejoin: round; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    const map = L.map('map', { zoomControl: true }).setView([39.8283, -98.5795], 4);
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    let stopsLayer = L.layerGroup().addTo(map);
    let restrictionsLayer = L.layerGroup().addTo(map);
    let routeLayer = L.layerGroup().addTo(map);
    let startMarker = null, endMarker = null, userMarker = null;

    function createIcon(color, text, size = 36) {
      return L.divIcon({
        className: 'custom-marker',
        html: '<div style="background:' + color + ';width:' + size + 'px;height:' + size + 'px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 3px 8px rgba(0,0,0,0.4);font-size:' + (size/2.5) + 'px;color:white;font-weight:bold;">' + text + '</div>',
        iconSize: [size, size],
        iconAnchor: [size/2, size/2]
      });
    }

    const icons = {
      start: createIcon('#22c55e', 'A', 40),
      end: createIcon('#ef4444', 'B', 40),
      fuel: createIcon('#f97316', '⛽', 32),
      rest: createIcon('#3b82f6', 'P', 32),
      parking: createIcon('#8b5cf6', '🚛', 32),
      weigh_station: createIcon('#6b7280', '⚖', 32),
      restriction: createIcon('#eab308', '⚠', 32),
      user: createIcon('#06b6d4', '📍', 36)
    };

    map.on('click', function(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'mapClick',
        data: { lat: e.latlng.lat, lng: e.latlng.lng }
      }));
    });

    function updateStops(stops) {
      stopsLayer.clearLayers();
      stops.forEach(stop => {
        const icon = icons[stop.type] || icons.fuel;
        const marker = L.marker([stop.lat, stop.lng], { icon: icon });
        marker.bindPopup('<div class="popup-title">' + stop.name + '</div><div>' + (stop.address || stop.state) + '</div>' +
          (stop.amenities ? '<div style="margin-top:5px;color:#666;font-size:11px;">' + stop.amenities.join(' • ') + '</div>' : ''));
        stopsLayer.addLayer(marker);
      });
    }

    function updateRestrictions(restrictions) {
      restrictionsLayer.clearLayers();
      restrictions.forEach(r => {
        const marker = L.marker([r.lat, r.lng], { icon: icons.restriction });
        marker.bindPopup('<div class="popup-title">⚠️ ' + r.road_name + '</div>' +
          '<div style="color:#666;">' + r.city + ', ' + r.state + '</div>' +
          '<div style="margin-top:5px;">' + r.description + '</div>' +
          (r.start_time ? '<div style="color:#eab308;margin-top:3px;">⏰ ' + r.start_time + ' - ' + r.end_time + '</div>' : ''));
        restrictionsLayer.addLayer(marker);
      });
    }

    function setUserLocation(loc) {
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([loc.lat, loc.lng], { icon: icons.user }).addTo(map);
      userMarker.bindPopup('<div class="popup-title">📍 Konumunuz</div>');
    }

    function setStart(loc) {
      if (startMarker) map.removeLayer(startMarker);
      startMarker = L.marker([loc.lat, loc.lng], { icon: icons.start }).addTo(map);
      startMarker.bindPopup('<div class="popup-title">🟢 Başlangıç</div>');
      map.setView([loc.lat, loc.lng], 10);
    }

    function setEnd(loc) {
      if (endMarker) map.removeLayer(endMarker);
      endMarker = L.marker([loc.lat, loc.lng], { icon: icons.end }).addTo(map);
      endMarker.bindPopup('<div class="popup-title">🔴 Varış</div>');
    }

    function drawRoute(coords) {
      routeLayer.clearLayers();
      
      if (coords.length < 2) return;
      
      // Draw route background (border effect)
      const bgLine = L.polyline(coords, {
        color: '#1e40af',
        weight: 10,
        opacity: 0.5,
        lineCap: 'round',
        lineJoin: 'round'
      });
      routeLayer.addLayer(bgLine);
      
      // Draw main route line
      const routeLine = L.polyline(coords, {
        color: '#3b82f6',
        weight: 6,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round'
      });
      routeLayer.addLayer(routeLine);
      
      // Fit map to route
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
    }

    function clearRoute() {
      routeLayer.clearLayers();
      if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
      if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
    }

    function handleMessage(event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'updateStops') updateStops(msg.data);
        else if (msg.type === 'updateRestrictions') updateRestrictions(msg.data);
        else if (msg.type === 'setUserLocation') setUserLocation(msg.data);
        else if (msg.type === 'setStart') setStart(msg.data);
        else if (msg.type === 'setEnd') setEnd(msg.data);
        else if (msg.type === 'drawRoute') drawRoute(msg.data);
        else if (msg.type === 'clearRoute') clearRoute();
      } catch (e) {}
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);
  </script>
</body>
</html>
`;

  const renderTabs = () => (
    <View style={styles.tabBar}>
      {[['map', '🗺️ Navigasyon'], ['stops', '⛽ Duraklar'], ['restrictions', '⚠️ Kisitlar'], ['settings', '⚙️ Ayarlar']].map(([key, label]) => (
        <TouchableOpacity
          key={key}
          style={[styles.tab, activeTab === key && styles.activeTab]}
          onPress={() => setActiveTab(key)}
        >
          <Text style={[styles.tabText, activeTab === key && styles.activeTabText]}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const renderMapPanel = () => (
    <View style={styles.mapContainer}>
      {/* Navigation Controls */}
      <View style={styles.navControls}>
        {/* Start Point */}
        <TouchableOpacity
          style={[styles.addressInput, selectingPoint === 'start' && styles.addressInputActive]}
          onPress={() => {
            setSearchingFor('start');
            setSearchQuery(startAddress);
          }}
        >
          <View style={[styles.pointDot, { backgroundColor: COLORS.success }]} />
          <Text style={styles.addressText} numberOfLines={1}>
            {startAddress || 'Baslangic noktasi sec...'}
          </Text>
          <TouchableOpacity 
            style={styles.mapSelectBtn}
            onPress={() => setSelectingPoint(selectingPoint === 'start' ? null : 'start')}
          >
            <Text style={styles.mapSelectBtnText}>{selectingPoint === 'start' ? '📍' : '🗺️'}</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        {/* End Point */}
        <TouchableOpacity
          style={[styles.addressInput, selectingPoint === 'end' && styles.addressInputActive]}
          onPress={() => {
            setSearchingFor('end');
            setSearchQuery(endAddress);
          }}
        >
          <View style={[styles.pointDot, { backgroundColor: COLORS.danger }]} />
          <Text style={styles.addressText} numberOfLines={1}>
            {endAddress || 'Varis noktasi sec...'}
          </Text>
          <TouchableOpacity 
            style={styles.mapSelectBtn}
            onPress={() => setSelectingPoint(selectingPoint === 'end' ? null : 'end')}
          >
            <Text style={styles.mapSelectBtnText}>{selectingPoint === 'end' ? '📍' : '🗺️'}</Text>
          </TouchableOpacity>
        </TouchableOpacity>

        {/* Action buttons */}
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.navBtn, styles.primaryBtn, (!startPoint || !endPoint || calculatingRoute) && styles.disabledBtn]}
            onPress={calculateRoute}
            disabled={!startPoint || !endPoint || calculatingRoute}
          >
            {calculatingRoute ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.navBtnText}>🚛 Rota Hesapla</Text>
            )}
          </TouchableOpacity>
          
          {routeInfo && (
            <TouchableOpacity
              style={[styles.navBtn, styles.infoBtn]}
              onPress={() => setShowDirections(true)}
            >
              <Text style={styles.navBtnText}>📋 Yonler</Text>
            </TouchableOpacity>
          )}
          
          <TouchableOpacity style={[styles.navBtn, styles.clearBtn]} onPress={clearRoute}>
            <Text style={styles.navBtnText}>🗑️</Text>
          </TouchableOpacity>
        </View>

        {/* Route Summary */}
        {routeInfo && (
          <View style={styles.routeSummary}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{routeInfo.distance}</Text>
              <Text style={styles.summaryLabel}>mil</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{routeInfo.duration}</Text>
              <Text style={styles.summaryLabel}>saat</Text>
            </View>
            {routeInfo.fallback && (
              <Text style={styles.fallbackText}>⚠️ Tahmini</Text>
            )}
          </View>
        )}

        {selectingPoint && (
          <View style={styles.selectingBanner}>
            <Text style={styles.selectingText}>
              👆 {selectingPoint === 'start' ? 'Baslangic' : 'Varis'} icin haritaya dokun
            </Text>
          </View>
        )}
      </View>

      {/* Filter buttons */}
      <View style={styles.mapFilters}>
        {[['fuel', '⛽'], ['rest', 'P'], ['parking', '🚛'], ['restrictions', '⚠️']].map(([key, icon]) => (
          <TouchableOpacity
            key={key}
            style={[styles.filterBtn, showFilters[key] && styles.filterBtnActive]}
            onPress={() => setShowFilters({ ...showFilters, [key]: !showFilters[key] })}
          >
            <Text style={styles.filterBtnText}>{icon}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Map */}
      <WebView
        ref={webViewRef}
        source={{ html: getMapHTML() }}
        style={styles.map}
        onMessage={handleWebViewMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        renderLoading={() => (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>Harita yukleniyor...</Text>
          </View>
        )}
      />

      {/* Search Modal */}
      <Modal visible={searchingFor !== null} animationType="slide" transparent={true}>
        <View style={styles.modalContainer}>
          <View style={styles.searchModal}>
            <View style={styles.searchHeader}>
              <Text style={styles.searchTitle}>
                {searchingFor === 'start' ? '🟢 Baslangic Noktasi' : '🔴 Varis Noktasi'}
              </Text>
              <TouchableOpacity onPress={() => { setSearchingFor(null); setSearchResults([]); }}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            
            <TextInput
              style={styles.searchInput}
              placeholder="Adres veya sehir ara..."
              placeholderTextColor={COLORS.textSecondary}
              value={searchQuery}
              onChangeText={(text) => {
                setSearchQuery(text);
                searchAddress(text);
              }}
              autoFocus={true}
            />

            <ScrollView style={styles.searchResultsList}>
              {searchResults.map((result, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.searchResultItem}
                  onPress={() => selectAddress(result)}
                >
                  <Text style={styles.searchResultIcon}>📍</Text>
                  <Text style={styles.searchResultText} numberOfLines={2}>{result.address}</Text>
                </TouchableOpacity>
              ))}
              {searchQuery.length >= 3 && searchResults.length === 0 && (
                <Text style={styles.noResults}>Sonuc bulunamadi</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Directions Modal */}
      <Modal visible={showDirections} animationType="slide" transparent={true}>
        <View style={styles.modalContainer}>
          <View style={styles.directionsModal}>
            <View style={styles.directionsHeader}>
              <Text style={styles.directionsTitle}>📋 Adim Adim Yonlendirme</Text>
              <TouchableOpacity onPress={() => setShowDirections(false)}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            
            {routeInfo && (
              <View style={styles.directionsSummary}>
                <Text style={styles.dirSummaryText}>📏 {routeInfo.distance} mil  •  ⏱️ {routeInfo.duration} saat</Text>
              </View>
            )}

            <ScrollView style={styles.directionsList}>
              {directions.map((dir, idx) => (
                <View key={dir.id} style={styles.directionItem}>
                  <View style={styles.directionNumber}>
                    <Text style={styles.directionNumberText}>{idx + 1}</Text>
                  </View>
                  <View style={styles.directionContent}>
                    <Text style={styles.directionInstruction}>{dir.instruction}</Text>
                    <Text style={styles.directionMeta}>
                      {dir.distance} mil • {dir.duration} dk
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );

  const renderStopsPanel = () => (
    <ScrollView style={styles.panel}>
      <Text style={styles.panelTitle}>⛽ Tir Duraklari</Text>
      <View style={styles.filterList}>
        {[['fuel', '⛽ Yakit', showFilters.fuel], ['rest', '🅿️ Dinlenme', showFilters.rest], 
          ['parking', '🚛 Park', showFilters.parking], ['weigh', '⚖️ Kantar', showFilters.weigh]].map(([key, label, active]) => (
          <TouchableOpacity key={key} style={[styles.filterItem, active && styles.filterItemActive]}
            onPress={() => setShowFilters({ ...showFilters, [key]: !active })}>
            <Text style={styles.filterItemText}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {truckStops.filter(s => (s.type === 'fuel' && showFilters.fuel) || (s.type === 'rest' && showFilters.rest) ||
        (s.type === 'parking' && showFilters.parking) || (s.type === 'weigh_station' && showFilters.weigh)).map((stop, idx) => (
        <View key={stop.id || idx} style={styles.stopCard}>
          <View style={styles.stopHeader}>
            <Text style={styles.stopIcon}>{stop.type === 'fuel' ? '⛽' : stop.type === 'rest' ? '🅿️' : stop.type === 'parking' ? '🚛' : '⚖️'}</Text>
            <View style={styles.stopInfo}>
              <Text style={styles.stopName}>{stop.name}</Text>
              <Text style={styles.stopAddress}>{stop.address || stop.state}</Text>
            </View>
          </View>
          {stop.amenities?.length > 0 && (
            <View style={styles.amenitiesRow}>
              {stop.amenities.slice(0, 4).map((a, i) => (
                <View key={i} style={styles.amenityTag}><Text style={styles.amenityText}>{a}</Text></View>
              ))}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );

  const renderRestrictionsPanel = () => (
    <ScrollView style={styles.panel}>
      <Text style={styles.panelTitle}>⚠️ Tir Kisitlamalari</Text>
      {restrictions.map((r, idx) => (
        <View key={r.id || idx} style={styles.restrictionCard}>
          <Text style={styles.restrictionRoad}>
            {r.restriction_type === 'no_trucks' ? '🚫' : r.restriction_type === 'height_limit' ? '📏' : r.restriction_type === 'weight_limit' ? '⚖️' : '🕐'} {r.road_name}
          </Text>
          <Text style={styles.restrictionLocation}>{r.city}, {r.state}</Text>
          <Text style={styles.restrictionDesc}>{r.description}</Text>
          {r.start_time && <Text style={styles.restrictionTime}>⏰ {r.start_time} - {r.end_time}</Text>}
          {r.limit_value && <Text style={styles.restrictionLimit}>Limit: {r.limit_value} {r.restriction_type === 'height_limit' ? 'ft' : 'lbs'}</Text>}
        </View>
      ))}
    </ScrollView>
  );

  const renderSettingsPanel = () => (
    <ScrollView style={styles.panel}>
      <Text style={styles.panelTitle}>⚙️ Tir Profili</Text>
      {[['height_feet', '📏 Yukseklik (ft)', '13.5'], ['weight_lbs', '⚖️ Agirlik (lbs)', '80000'],
        ['width_feet', '↔️ Genislik (ft)', '8.5'], ['length_feet', '📐 Uzunluk (ft)', '75']].map(([key, label, hint]) => (
        <View key={key} style={styles.formGroup}>
          <Text style={styles.formLabel}>{label}</Text>
          <TextInput style={styles.formInput} keyboardType="numeric" value={String(truckProfile[key])}
            onChangeText={(val) => setTruckProfile({ ...truckProfile, [key]: parseFloat(val) || 0 })}
            placeholder={hint} placeholderTextColor={COLORS.textSecondary} />
        </View>
      ))}
      <TouchableOpacity style={[styles.filterItem, truckProfile.hazmat && styles.filterItemActive, { marginTop: 10 }]}
        onPress={() => setTruckProfile({ ...truckProfile, hazmat: !truckProfile.hazmat })}>
        <Text style={styles.filterItemText}>☢️ Tehlikeli Madde (HAZMAT)</Text>
      </TouchableOpacity>
      <View style={styles.profileSummary}>
        <Text style={styles.summaryTitle}>📋 Profil Ozeti</Text>
        <Text style={styles.summaryText}>Yukseklik: {truckProfile.height_feet} ft</Text>
        <Text style={styles.summaryText}>Agirlik: {truckProfile.weight_lbs.toLocaleString()} lbs</Text>
        <Text style={styles.summaryText}>Genislik: {truckProfile.width_feet} ft</Text>
        <Text style={styles.summaryText}>Uzunluk: {truckProfile.length_feet} ft</Text>
        <Text style={styles.summaryText}>HAZMAT: {truckProfile.hazmat ? '✅ Evet' : '❌ Hayir'}</Text>
      </View>
    </ScrollView>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.loadingScreen}>
          <Text style={styles.loadingLogo}>🚛</Text>
          <Text style={styles.loadingTitle}>TruckRoute USA</Text>
          <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 20 }} />
          <Text style={styles.loadingSubtext}>Yukleniyor...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🚛 TruckRoute USA</Text>
      </View>
      {renderTabs()}
      <View style={styles.content}>
        {activeTab === 'map' && renderMapPanel()}
        {activeTab === 'stops' && renderStopsPanel()}
        {activeTab === 'restrictions' && renderRestrictionsPanel()}
        {activeTab === 'settings' && renderSettingsPanel()}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: { paddingTop: Platform.OS === 'android' ? 35 : 5, paddingBottom: 10, paddingHorizontal: 15, backgroundColor: COLORS.secondary, borderBottomWidth: 1, borderBottomColor: '#334155' },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  tabBar: { flexDirection: 'row', backgroundColor: COLORS.secondary, borderBottomWidth: 1, borderBottomColor: '#334155' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  activeTab: { backgroundColor: COLORS.primary },
  tabText: { fontSize: 10, color: COLORS.textSecondary, fontWeight: '600' },
  activeTabText: { color: COLORS.text },
  content: { flex: 1 },
  
  // Map & Navigation
  mapContainer: { flex: 1 },
  navControls: { backgroundColor: COLORS.card, padding: 10, borderBottomWidth: 1, borderBottomColor: '#334155' },
  addressInput: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.background, borderRadius: 8, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: '#334155' },
  addressInputActive: { borderColor: COLORS.primary },
  pointDot: { width: 12, height: 12, borderRadius: 6, marginRight: 10 },
  addressText: { flex: 1, color: COLORS.text, fontSize: 13 },
  mapSelectBtn: { padding: 5 },
  mapSelectBtnText: { fontSize: 18 },
  actionRow: { flexDirection: 'row', gap: 8 },
  navBtn: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  primaryBtn: { flex: 1, backgroundColor: COLORS.primary },
  infoBtn: { backgroundColor: '#334155' },
  clearBtn: { backgroundColor: '#334155', paddingHorizontal: 15 },
  disabledBtn: { opacity: 0.5 },
  navBtnText: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  routeSummary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, padding: 10, backgroundColor: COLORS.background, borderRadius: 8 },
  summaryItem: { alignItems: 'center', paddingHorizontal: 20 },
  summaryValue: { fontSize: 22, fontWeight: 'bold', color: COLORS.primary },
  summaryLabel: { fontSize: 11, color: COLORS.textSecondary },
  summaryDivider: { width: 1, height: 30, backgroundColor: '#334155' },
  fallbackText: { fontSize: 10, color: COLORS.warning, marginLeft: 10 },
  selectingBanner: { marginTop: 8, padding: 8, backgroundColor: COLORS.warning, borderRadius: 8 },
  selectingText: { color: '#000', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  mapFilters: { position: 'absolute', top: 200, right: 10, zIndex: 1000, gap: 5 },
  filterBtn: { width: 36, height: 36, backgroundColor: 'rgba(30,41,59,0.95)', borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#334155' },
  filterBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterBtnText: { fontSize: 16 },
  map: { flex: 1 },
  loadingContainer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: COLORS.textSecondary, marginTop: 10 },

  // Modal styles
  modalContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  searchModal: { backgroundColor: COLORS.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: height * 0.7, padding: 15 },
  searchHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  searchTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
  closeBtn: { fontSize: 24, color: COLORS.textSecondary, padding: 5 },
  searchInput: { backgroundColor: COLORS.background, borderRadius: 10, padding: 12, color: COLORS.text, fontSize: 15, borderWidth: 1, borderColor: '#334155' },
  searchResultsList: { marginTop: 10, maxHeight: 300 },
  searchResultItem: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#334155' },
  searchResultIcon: { fontSize: 20, marginRight: 10 },
  searchResultText: { flex: 1, color: COLORS.text, fontSize: 14 },
  noResults: { color: COLORS.textSecondary, textAlign: 'center', padding: 20 },

  // Directions modal
  directionsModal: { backgroundColor: COLORS.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: height * 0.8, padding: 15 },
  directionsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  directionsTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.text },
  directionsSummary: { backgroundColor: COLORS.primary, padding: 12, borderRadius: 10, marginBottom: 10 },
  dirSummaryText: { color: COLORS.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  directionsList: { maxHeight: 400 },
  directionItem: { flexDirection: 'row', padding: 12, borderBottomWidth: 1, borderBottomColor: '#334155' },
  directionNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  directionNumberText: { color: COLORS.text, fontWeight: 'bold', fontSize: 12 },
  directionContent: { flex: 1 },
  directionInstruction: { color: COLORS.text, fontSize: 14, marginBottom: 3 },
  directionMeta: { color: COLORS.textSecondary, fontSize: 12 },

  // Panel styles
  panel: { flex: 1, padding: 15 },
  panelTitle: { fontSize: 20, fontWeight: 'bold', color: COLORS.text, marginBottom: 15 },
  filterList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 15 },
  filterItem: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: COLORS.card, borderRadius: 20, borderWidth: 1, borderColor: '#334155' },
  filterItemActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterItemText: { color: COLORS.text, fontSize: 13 },
  stopCard: { backgroundColor: COLORS.card, padding: 15, borderRadius: 12, marginBottom: 10 },
  stopHeader: { flexDirection: 'row', alignItems: 'center' },
  stopIcon: { fontSize: 28, marginRight: 12 },
  stopInfo: { flex: 1 },
  stopName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  stopAddress: { fontSize: 12, color: COLORS.textSecondary, marginTop: 2 },
  amenitiesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  amenityTag: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#334155', borderRadius: 12 },
  amenityText: { fontSize: 11, color: COLORS.textSecondary },
  restrictionCard: { backgroundColor: COLORS.card, padding: 15, borderRadius: 12, marginBottom: 10, borderLeftWidth: 4, borderLeftColor: COLORS.warning },
  restrictionRoad: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: 5 },
  restrictionLocation: { fontSize: 12, color: COLORS.textSecondary },
  restrictionDesc: { fontSize: 13, color: COLORS.text, marginTop: 5 },
  restrictionTime: { fontSize: 12, color: COLORS.warning, marginTop: 5 },
  restrictionLimit: { fontSize: 12, color: COLORS.warning },
  formGroup: { marginBottom: 15 },
  formLabel: { fontSize: 14, color: COLORS.text, marginBottom: 8, fontWeight: '500' },
  formInput: { padding: 12, backgroundColor: COLORS.card, borderRadius: 10, color: COLORS.text, fontSize: 16, borderWidth: 1, borderColor: '#334155' },
  profileSummary: { marginTop: 20, padding: 20, backgroundColor: COLORS.card, borderRadius: 12, borderWidth: 1, borderColor: COLORS.primary },
  summaryTitle: { fontSize: 16, fontWeight: '600', color: COLORS.text, marginBottom: 12 },
  summaryText: { fontSize: 14, color: COLORS.textSecondary, marginBottom: 5 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingLogo: { fontSize: 60 },
  loadingTitle: { fontSize: 28, fontWeight: 'bold', color: COLORS.text, marginTop: 15 },
  loadingSubtext: { color: COLORS.textSecondary, marginTop: 10 },
});
