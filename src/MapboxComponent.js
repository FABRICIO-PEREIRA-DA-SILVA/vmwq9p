import React, { useRef, useEffect, useState, useCallback } from "react";
import "./styles.css";
import mapboxgl from "mapbox-gl";
import * as turf from "@turf/turf";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken =
  "pk.eyJ1IjoiYXZhc2ZhYnJpY2lvMSIsImEiOiJjbWJ5OWt6ZGgxbG1sMnBwdzM1eGVlcGMzIn0.4U9BwtVpiOQ9r6BCSMr5bQ";

function getBearingFromRoute(position, routeGeo) {
  try {
    if (
      !routeGeo ||
      !routeGeo.geometry ||
      routeGeo.geometry.coordinates.length < 2
    ) {
      return null;
    }

    const userPoint = turf.point(position);
    const snapped = turf.nearestPointOnLine(routeGeo, userPoint, {
      units: "meters",
    });
    const coords = routeGeo.geometry.coordinates;
    const idx = snapped.properties.index;

    let nextCoord = coords[idx + 1];
    if (!nextCoord && idx > 0) {
      nextCoord = coords[idx - 1];
    }

    if (!nextCoord) return null;

    const nextPoint = turf.point(nextCoord);
    const bearingRaw = turf.bearing(snapped, nextPoint);
    return (bearingRaw + 360) % 360;
  } catch (err) {
    console.error("getBearingFromRoute erro:", err);
    return null;
  }
}

function MapboxComponent({
  origin,
  destinations = [],
  isVisible,
  onClose,
  onMarkerClick,
}) {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markerRef = useRef(null);
  const alreadyTraveledCoords = useRef([]);
  const [shouldFollow, setShouldFollow] = useState(true);
  const selectedMarkerRef = useRef(null);
  const routeGeoJSON = useRef(null);
  const lastRecalculation = useRef(0);
  const wakeLockSentinelRef = useRef(null);

  const lastKnownStableBearing = useRef(0);
  const recenterClicked = useRef(false);
  const lastKnownPosition = useRef(null);
  const animationFrame = useRef(null);
  const targetLngLat = useRef(null); // Posição alvo
  const currentLngLat = useRef(null); // Posição atual interpolada

  // NOVO: Ref para guardar os marcadores dos destinos que estão no mapa.
  // Isso é essencial para saber quais marcadores remover depois.
  const destinationMarkersRef = useRef({});
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    let animationId;

    const animate = () => {
      if (currentLngLat.current && targetLngLat.current) {
        const { lng: clng, lat: clat } = currentLngLat.current;
        const { lng: tlng, lat: tlat } = targetLngLat.current;

        const deltaLng = (tlng - clng) * 0.1;
        const deltaLat = (tlat - clat) * 0.1;

        const newLng = clng + deltaLng;
        const newLat = clat + deltaLat;

        currentLngLat.current = { lng: newLng, lat: newLat };

        if (markerRef.current) {
          markerRef.current.setLngLat([newLng, newLat]);
        }
      }

      animationId = requestAnimationFrame(animate);
    };

    animate();

    return () => cancelAnimationFrame(animationId);
  }, []);

  const setMarkerFill = useCallback((marker, color) => {
    const path = marker.getElement().querySelector("path");
    if (path) {
      path.setAttribute("fill", color);
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (
      "wakeLock" in navigator &&
      document.visibilityState === "visible" &&
      isVisible
    ) {
      try {
        wakeLockSentinelRef.current = await navigator.wakeLock.request(
          "screen"
        );
        console.log("Wake Lock ativado!");
        wakeLockSentinelRef.current.addEventListener("release", () => {
          console.log(
            "Wake Lock liberado pelo sistema (aba inativa ou fechada)."
          );
          wakeLockSentinelRef.current = null;
        });
      } catch (err) {
        console.error(`Erro ao ativar Wake Lock: ${err.name}, ${err.message}`);
      }
    }
  }, [isVisible]);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockSentinelRef.current) {
      wakeLockSentinelRef.current.release();
      wakeLockSentinelRef.current = null;
      console.log("Wake Lock liberado manualmente.");
    }
  }, []);

  const fetchAndDrawRoute = useCallback(
    async (newOrigin) => {
      if (
        !Array.isArray(newOrigin) ||
        newOrigin.length !== 2 ||
        !newOrigin.every((coord) => typeof coord === "number")
      ) {
        console.warn(
          "fetchAndDrawRoute: newOrigin inválido. Não é possível buscar a rota."
        );
        return;
      }

      const allCoords = [newOrigin, ...destinations]
        .map((coord) => {
          const actualCoord = Array.isArray(coord) ? coord : coord.coords;
          if (
            !Array.isArray(actualCoord) ||
            actualCoord.length !== 2 ||
            !actualCoord.every((c) => typeof c === "number")
          ) {
            console.warn(
              "fetchAndDrawRoute: Coordenada de destino inválida, ignorando.",
              coord
            );
            return null;
          }
          return `${actualCoord[0]},${actualCoord[1]}`;
        })
        .filter(Boolean)
        .join(";");

      if (allCoords.split(";").length < 2) {
        console.warn(
          "Não há coordenadas suficientes para traçar uma rota após a validação."
        );
        if (map.current && map.current.getSource("route")) {
          map.current.getSource("route").setData({
            type: "FeatureCollection",
            features: [],
          });
        }
        return;
      }

      const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${allCoords}?geometries=geojson&overview=full&steps=true&access_token=${mapboxgl.accessToken}`;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          const errorData = await res.json();
          console.error(
            "Erro na resposta da API do Mapbox:",
            res.status,
            errorData
          );
          return;
        }
        const data = await res.json();

        if (!data.routes || data.routes.length === 0) {
          console.warn(
            "Nenhuma rota encontrada para as coordenadas fornecidas.",
            {
              origin: newOrigin,
              destinations: destinations,
              data: data,
            }
          );
          if (map.current.getSource("route")) {
            map.current.getSource("route").setData({
              type: "FeatureCollection",
              features: [],
            });
          }
          return;
        }

        const route = data.routes[0].geometry;

        routeGeoJSON.current = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: route.coordinates,
          },
        };

        if (map.current.getSource("route")) {
          const gray = alreadyTraveledCoords.current;
          let features;

          if (gray && gray.length > 1) {
            features = [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: gray,
                },
                properties: { color: "gray" },
              },
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: route.coordinates,
                },
                properties: { color: "blue" },
              },
            ];
          } else {
            features = [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: route.coordinates,
                },
                properties: { color: "blue" },
              },
            ];
          }

          map.current.getSource("route").setData({
            type: "FeatureCollection",
            features,
          });
        } else {
          map.current.addSource("route", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: route,
                  properties: { color: "blue" },
                },
              ],
            },
          });
        }

        if (!map.current.getLayer("route-blue-outline")) {
          map.current.addLayer({
            id: "route-blue-outline",
            type: "line",
            source: "route",
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": "#ffffff",
              "line-width": 12,
              "line-opacity": 0.8,
            },
            filter: ["==", ["get", "color"], "blue"],
          });
        }

        if (!map.current.getLayer("route-blue")) {
          map.current.addLayer({
            id: "route-blue",
            type: "line",
            source: "route",
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": "#0074D9",
              "line-width": 8,
            },
            filter: ["==", ["get", "color"], "blue"],
          });
        }

        if (!map.current.getLayer("route-gray")) {
          map.current.addLayer({
            id: "route-gray",
            type: "line",
            source: "route",
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": "#AAAAAA",
              "line-width": 10,
            },
            filter: ["==", ["get", "color"], "gray"],
          });
        }
      } catch (error) {
        console.error("Erro ao buscar ou processar a rota do Mapbox:", error);
      }
    },
    [destinations]
  ); // Removido fetchAndDrawRoute daqui para evitar loop

  // CÓDIGO CORRIGIDO - SUBSTITUA ESTE BLOCO INTEIRO
  useEffect(() => {
    if (!isVisible) return;

    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const {
          longitude,
          latitude,
          speed,
          heading: gpsRawHeading,
        } = pos.coords;
        const newPosition = [longitude, latitude];
        if (
          typeof longitude !== "number" ||
          typeof latitude !== "number" ||
          isNaN(longitude) ||
          isNaN(latitude)
        ) {
          console.warn(
            "Localização GPS inválida recebida (longitude ou latitude não é número). Ignorando atualização."
          );
          return;
        }

        lastKnownPosition.current = newPosition;

        if (!markerRef.current) {
          const markerOuter = document.createElement("div");
          markerOuter.className = "gps-marker";

          const markerInner = document.createElement("div");
          markerInner.className = "gps-pulse-inner";

          markerOuter.appendChild(markerInner);

          markerRef.current = new mapboxgl.Marker({ element: markerOuter })
            .setLngLat(newPosition)
            .addTo(map.current);
        } else {
          // --- INÍCIO DA MODIFICAÇÃO ---
          // Verifica se já temos uma rota desenhada para poder "colar" o marcador nela
          if (
            routeGeoJSON.current &&
            routeGeoJSON.current.geometry &&
            routeGeoJSON.current.geometry.coordinates.length >= 2
          ) {
            try {
              const userPoint = turf.point(newPosition);
              const routeLine = routeGeoJSON.current;

              // Calcula o ponto mais próximo na rota
              const snapped = turf.nearestPointOnLine(routeLine, userPoint, {
                units: "meters",
              });

              // Calcula a distância entre a posição real e o ponto na rota
              const distance = turf.distance(userPoint, snapped, {
                units: "meters",
              });

              // Se a distância for menor que 50 metros, "cola" o marcador na rota
              if (distance < 50) {
                const newLngLat = {
                  lng: snapped.geometry.coordinates[0],
                  lat: snapped.geometry.coordinates[1],
                };
                targetLngLat.current = newLngLat;

                if (!currentLngLat.current) {
                  currentLngLat.current = newLngLat;
                  if (markerRef.current) {
                    markerRef.current.setLngLat([newLngLat.lng, newLngLat.lat]);
                  }
                }
              }
            } catch (e) {
              console.error("Erro ao 'colar' o marcador na rota:", e);
              // Em caso de erro, usa a posição real como fallback
              markerRef.current.setLngLat(newPosition);
              currentLngLat.current = {
                lng: newPosition[0],
                lat: newPosition[1],
              };
            }
          } else {
            // Se ainda não houver rota, apenas atualiza com a posição real
            const newLngLat = { lng: longitude, lat: latitude }; // Apenas uma declaração é necessária

            // A linha abaixo não parece ser utilizada, pode ser removida se for o caso
            // const previousLngLat = currentLngLat.current || newLngLat;

            targetLngLat.current = newLngLat;

            // Se for a primeira vez, seta também a posição atual:
            if (!currentLngLat.current) {
              currentLngLat.current = newLngLat;
              if (markerRef.current) {
                markerRef.current.setLngLat([newLngLat.lng, newLngLat.lat]);
              }
            }
          }
          // --- FIM DA MODIFICAÇÃO ---
        }

        let finalMapBearing = lastKnownStableBearing.current;
        const speedThreshold = 0.5;

        if (recenterClicked.current && speed <= speedThreshold) {
          finalMapBearing = 0;
        } else if (speed > speedThreshold) {
          recenterClicked.current = false;

          if (
            typeof gpsRawHeading === "number" &&
            !Number.isNaN(gpsRawHeading)
          ) {
            finalMapBearing = gpsRawHeading;
          } else {
            const bearingFromRoute = getBearingFromRoute(
              newPosition,
              routeGeoJSON.current
            );
            if (bearingFromRoute !== null) {
              finalMapBearing = bearingFromRoute;
            }
          }
          if (
            typeof finalMapBearing === "number" &&
            !Number.isNaN(finalMapBearing)
          ) {
            lastKnownStableBearing.current = finalMapBearing;
          }
        }

        if (shouldFollow && map.current) {
          map.current.easeTo({
            center: markerRef.current.getLngLat(), // Usa a posição do marcador (que pode estar "colada" na rota)
            bearing: finalMapBearing,
            zoom: 17,
            pitch: 60,
            duration: 500,
            offset: [50, window.innerHeight / 5],
          });
        }

        const now = Date.now();
        if (
          routeGeoJSON.current &&
          routeGeoJSON.current.geometry &&
          Array.isArray(routeGeoJSON.current.geometry.coordinates) &&
          routeGeoJSON.current.geometry.coordinates.length >= 2 &&
          Array.isArray(newPosition) &&
          newPosition.length === 2 &&
          newPosition.every((coord) => typeof coord === "number") &&
          now - lastRecalculation.current > 15000
        ) {
          const point = turf.point(newPosition);
          const line = routeGeoJSON.current;

          try {
            const snapped = turf.nearestPointOnLine(line, point, {
              units: "meters",
            });

            const distance = turf.distance(point, snapped, { units: "meters" });

            const coords = line.geometry.coordinates;

            const index = snapped.properties.index;

            const coordsBefore = coords.slice(0, index + 1);
            coordsBefore.push(snapped.geometry.coordinates);

            alreadyTraveledCoords.current = coordsBefore;

            const coordsAfter = [
              snapped.geometry.coordinates,
              ...coords.slice(index + 1),
            ];

            const updated = {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: coordsBefore,
                  },
                  properties: { color: "gray" },
                },
                {
                  type: "Feature",
                  geometry: {
                    type: "LineString",
                    coordinates: coordsAfter,
                  },
                  properties: { color: "blue" },
                },
              ],
            };

            map.current.getSource("route").setData(updated);

            if (distance > 70) {
              console.log("Fora da rota! Recalculando...");
              await fetchAndDrawRoute(newPosition);
              lastRecalculation.current = now;
            }
          } catch (error) {
            console.error(
              "Erro ao usar turf.nearestPointOnLine ou turf.distance:",
              error
            );
          }
        }
      },
      (err) => {
        console.error("Erro ao obter localização:", err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 5000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      cancelAnimationFrame(animationFrame.current);
    };
  }, [shouldFollow, isVisible, fetchAndDrawRoute]);

  const fitMapToBounds = useCallback(() => {
    if (!map.current) {
      console.warn(
        "fitMapToBounds: Mapa não inicializado. Não é possível ajustar os limites."
      );
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasValidPoints = false;

    if (
      Array.isArray(origin) &&
      origin.length === 2 &&
      origin.every((c) => typeof c === "number")
    ) {
      bounds.extend(origin);
      hasValidPoints = true;
    } else {
      console.warn("fitMapToBounds: Origem inválida, não incluída nos bounds.");
    }

    destinations.forEach((dest) => {
      const actualCoords = Array.isArray(dest) ? dest : dest.coords;
      if (
        Array.isArray(actualCoords) &&
        actualCoords.length === 2 &&
        actualCoords.every((c) => typeof c === "number")
      ) {
        bounds.extend(actualCoords);
        hasValidPoints = true;
      } else {
        console.warn(
          "fitMapToBounds: Destino inválido encontrado, ignorando-o.",
          dest
        );
      }
    });

    if (hasValidPoints && !bounds.isEmpty()) {
      map.current.fitBounds(bounds, {
        padding: 80,
        duration: 1000,
        maxZoom: 16,
      });
    } else {
      console.warn(
        "Não há pontos válidos (origem ou destinos) para ajustar a visão geral."
      );
      if (map.current) {
        let initialCenter = [0, 0];
        if (
          Array.isArray(origin) &&
          origin.length === 2 &&
          typeof origin[0] === "number" &&
          typeof origin[1] === "number" &&
          !isNaN(origin[0]) &&
          !isNaN(origin[1])
        ) {
          initialCenter = origin;
        }
        map.current.flyTo({ center: initialCenter, zoom: 10 });
      }
    }
  }, [origin, destinations]);

  // ALTERADO: Este useEffect agora cuida da inicialização E da atualização dos marcadores.
  useEffect(() => {
    if (!isVisible) return;

    // --- Bloco de Inicialização do Mapa (só roda uma vez) ---
    if (!map.current) {
      let initialCenter = [0, 0];
      if (
        Array.isArray(origin) &&
        origin.length === 2 &&
        typeof origin[0] === "number" &&
        typeof origin[1] === "number" &&
        !isNaN(origin[0]) &&
        !isNaN(origin[1])
      ) {
        initialCenter = origin;
      } else {
        console.warn(
          "Prop 'origin' inválida ou não fornecida. Usando [0, 0] como centro inicial."
        );
      }

      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/streets-v11",
        center: initialCenter,
        bearing: 0,
        pitch: 60,
      });

      map.current.on("dragstart", () => setShouldFollow(false));
      map.current.on("zoomstart", () => setShouldFollow(false));

      map.current.on("load", () => {
        console.log("✅ Mapa completamente carregado!");
        // 👇 ADICIONE ESTA LINHA DENTRO DO 'load'
        setMapLoaded(true);
        // Agora, o 'load' só ajusta a visão inicial.
        // A criação dos marcadores é feita na lógica de sincronização abaixo.
        fitMapToBounds();
      });
    }

    // --- Bloco de Sincronização de Marcadores (roda sempre que 'destinations' muda) ---
    if (map.current) {
      const currentMarkers = destinationMarkersRef.current;
      const newDestinationIds = new Set(destinations.map((d) => d.Endereço));

      // 1. REMOVER marcadores que não estão mais na lista de destinos
      Object.keys(currentMarkers).forEach((markerId) => {
        if (!newDestinationIds.has(markerId)) {
          console.log(`Removendo marcador: ${markerId}`);
          currentMarkers[markerId].remove(); // Remove do mapa
          if (selectedMarkerRef.current === currentMarkers[markerId]) {
            selectedMarkerRef.current = null;
          }
          delete currentMarkers[markerId]; // Remove da nossa referência
        }
      });

      // 2. ADICIONAR novos marcadores que ainda não existem no mapa
      destinations.forEach((dest) => {
        const markerId = dest.Endereço;
        if (!currentMarkers[markerId]) {
          const actualCoords = Array.isArray(dest) ? dest : dest.coords;
          if (
            Array.isArray(actualCoords) &&
            actualCoords.length === 2 &&
            actualCoords.every((c) => typeof c === "number")
          ) {
            console.log(`Adicionando marcador: ${markerId}`);
            const marker = new mapboxgl.Marker({ color: "red" })
              .setLngLat(actualCoords)
              .addTo(map.current);

            marker.getElement().addEventListener("click", () => {
              if (onMarkerClick) {
                if (
                  selectedMarkerRef.current &&
                  selectedMarkerRef.current !== marker
                ) {
                  setMarkerFill(selectedMarkerRef.current, "red");
                }
                setMarkerFill(marker, "#00AA00");
                selectedMarkerRef.current = marker;
                onMarkerClick(dest);
              }
            });
            // Guarda o novo marcador na nossa referência
            currentMarkers[markerId] = marker;
          }
        }
      });
    }
  }, [
    isVisible,
    origin,
    destinations,
    fitMapToBounds,
    onMarkerClick,
    setMarkerFill,
  ]);

  // USE ESSE, É O CERTO.
  // Ele vai ser o ÚNICO useEffect responsável por desenhar a rota principal.
  const routeDrawnForDestinations = useRef(null);

  useEffect(() => {
    // 👇 MUDANÇA 1: Adicione a verificação !mapLoaded
    if (!mapLoaded || !map.current || !origin || destinations.length === 0) {
      return;
    }

    const destinationsKey = JSON.stringify(destinations);
    if (routeDrawnForDestinations.current === destinationsKey) {
      return;
    }

    console.log(
      "Mapa carregado e destinos novos/diferentes. Desenhando a rota."
    );
    fetchAndDrawRoute(origin);

    routeDrawnForDestinations.current = destinationsKey;

    // 👇 MUDANÇA 2: Adicione mapLoaded na lista de dependências
  }, [mapLoaded, origin, destinations, fetchAndDrawRoute]);

  useEffect(() => {
    if (isVisible) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && isVisible) {
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      releaseWakeLock();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isVisible, requestWakeLock, releaseWakeLock]);
  const forceFollowNow = () => {
    const position = lastKnownPosition.current;
    if (!position || !map.current) return;

    const bearing = lastKnownStableBearing.current || 0;

    if (markerRef.current) {
      markerRef.current.setLngLat(position);
    }

    map.current.easeTo({
      center: position,
      bearing: bearing,
      zoom: 17,
      pitch: 60,
      duration: 500,
      offset: [50, window.innerHeight / 5],
    });
  };

  const handleRecenterClick = () => {
    console.log("Botão Recentralizar clicado!");

    if (!lastKnownPosition.current || !map.current) return;

    const bearing = lastKnownStableBearing.current || 0;

    // Passo 1: Move o mapa imediatamente pro ponto correto
    map.current.easeTo({
      center: lastKnownPosition.current,
      bearing: bearing,
      zoom: 17,
      pitch: 60,
      offset: [50, window.innerHeight / 5],
      duration: 500, // meio segundo pra animar
    });

    // Passo 2: Ativa o seguir após a animação
    setTimeout(() => {
      setShouldFollow(true);
      recenterClicked.current = true;
      console.log("Modo seguir ativado");
    }, 550); // 50ms a mais que o duration do easeTo
  };

  const handleGeralClick = () => {
    console.log("Botão Geral clicado!");
    setShouldFollow(false);
    fitMapToBounds();
  };

  return isVisible ? (
    <div style={{ position: "relative", width: "100%", height: "60vh" }}>
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />
        <button
          onClick={handleRecenterClick}
          style={{
            position: "absolute",
            bottom: 5,
            left: 5,
            zIndex: 10,
            background: "white",
            border: "1px solid #ccc",
            borderRadius: "20%",
            width: 115,
            height: 35,
            cursor: "pointer",
            fontWeight: "bold",
          }}
          title="Recentralizar"
        >
          📍 Recentralizar
        </button>
        <button
          onClick={handleGeralClick}
          style={{
            position: "absolute",
            bottom: 5,
            right: 5,
            zIndex: 10,
            background: "white",
            border: "1px solid #ccc",
            borderRadius: "20%",
            width: 80,
            height: 35,
            cursor: "pointer",
            fontWeight: "bold",
          }}
          title="Visão Geral"
        >
          Geral
        </button>
      </div>
    </div>
  ) : null;
}

export default MapboxComponent;
