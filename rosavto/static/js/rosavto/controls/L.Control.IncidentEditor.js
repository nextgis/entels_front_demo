define([
    'dojo/_base/lang'
],
    function (lang) {
        L.Control.IncidentEditor = L.Control.extend({
            options: {
                position: 'topleft',
                modes: ['point', 'line'],
                activeMode: 'point',
                pointModeText: 'Создать точку происшествия',
                lineModeText: 'Создать отрезок происшествия',
                eraseText: 'Стереть объект',
                editorLayerStyle: {color: '#FF0000', weight: 10, opacity: 0.5 },
                callbackDistanceChange: function (data) {
                    console.log('IncidentEditor: ' + data);
                },
                ngwServiceFacade: null,
                map: null,
                roadGuid: null,
                idLayer: null
            },

            onAdd: function (map) {
                var incidentName = 'incident-editor',
                    container = L.DomUtil.create('div', incidentName + ' leaflet-bar'),
                    options = this.options,
                    modesCount = options.modes.length,
                    i,
                    modeName;

                if (modesCount > 1) {
                    for (i = 0; i < modesCount; i += 1) {
                        modeName = options.modes[i];
                        this._createButton(options[modeName + 'ModeText'], modeName + '-mode', container, this['_' + modeName + 'ModeTurnOn']);

                        if (modeName === 'line') {
                            this._createEraseButton(container);
                        }
                    }
                } else if (modesCount === 1 && options.modes[0] === 'line') {
                    this._createEraseButton(container);
                }

                this._editorLayer = L.geoJson(null, {
                    style: options.editorLayerStyle,
                    pointToLayer: function (geojson, latlng) {
                        return L.circle(latlng, 10);
                    }
                });
                this._editorLayer.addTo(map);


                map.on('click', lang.hitch(this, function (e) {
                    this._clickHandler(e.latlng);
                }));
                this._markers = [];

                if (modesCount === 1) {
                    options.activeMode = options.modes[0];
                }
                this._setMode(options.activeMode);
                this._clearAll();

                return container;
            },

            setRoadGuid: function (guid) {
                this.options.roadGuid = guid;
                this._clearGeo();
            },

            _createEraseButton: function (container) {
                this._createButton(this.options.eraseText, 'erase', container, this._clearAll);
            },

            erase: function () {
                this._clearAll();
            },

            _createButton: function (title, className, container, fn) {
                var link = L.DomUtil.create('a', className, container);
                link.href = '#';
                link.title = title;

                L.DomEvent
                    .on(link, 'mousedown dblclick', L.DomEvent.stopPropagation)
                    .on(link, 'click', L.DomEvent.stop)
                    .on(link, 'click', fn, this);

                return link;
            },

            _setMode: function (mode) {
                if (mode) {
                    this.options.activeMode = mode;
                }
            },

            _clearAll: function () {
                switch (this.options.activeMode) {
                    case 'point':
                        this._distances = this._getEmptyDistancePoint();
                        break;

                    case 'line':
                        this._distances = {
                            begin: this._getEmptyDistancePoint(),
                            end: this._getEmptyDistancePoint()
                        };
                        break;

                    default:
                        console.log('L.Control.IncidentEditor: "' + mode + '" is not supported.');
                }

                var distance = this._getDistance();
                this.options.callbackDistanceChange.apply(this, [distance]);

                this._clearGeo();
            },

            _getEmptyDistancePoint: function () {
                return {
                    guid: null,
                    km: null,
                    m: null
                };
            },

            _getDistance: function () {
                return {
                    mode: this.options.activeMode,
                    distances: this._distances
                }
            },

            _pointModeTurnOn: function () {
                this._setMode('point');
                this._clearAll();
            },

            _lineModeTurnOn: function () {
                this._setMode('line');
                this._clearAll();
            },

            _clearGeo: function () {
                var markersCount = this._markers.length,
                    i;

                if (markersCount > 0) {
                    for (i = 0; i < markersCount; i += 1) {
                        this._map.removeLayer(this._markers[i]);
                    }
                    this._markers = [];
                }

                if (this._editorLayer) {
                    this._editorLayer.clearLayers();
                }
            },

            _clickHandler: function (latlng) {
                var mode = this.options.activeMode;

                this['_' + mode + 'ClickHandler'](latlng);
            },

            _pointClickHandler: function (latlng) {
                if (this._markers.length === 0) {
                    this.snapMarker(this._createMarker(latlng, this._distances));
                }
            },

            _lineClickHandler: function (latlng) {
                var markersCount = this._markers.length,
                    distance = markersCount === 0 ? this._distances.begin : this._distances.end;
                if (markersCount < 2) {
                    this.snapMarker(this._createMarker(latlng, distance));
                }
            },

            snapMarker: function (marker) {
                var self = this,
                    options = this.options,
                    xhrPointProjection = this.options.ngwServiceFacade.getPointProjection(
                        options.idLayer,
                        options.roadGuid,
                        marker._latlng.lat,
                        marker._latlng.lng
                    ),
                    xhrLatLngByDistance;

                xhrPointProjection.then(function (data) {
                    if (data.distance) {
                        marker.distance.guid = options.roadGuid;
                        marker.distance.km = Math.floor(data.distance / 1000);
                        marker.distance.m = data.distance - marker.distance.km * 1000;
                        options.callbackDistanceChange(self._getDistance());

                        xhrLatLngByDistance = self.options.ngwServiceFacade.getIncident([
                            {
                                layer: options.idLayer,
                                guid: options.roadGuid,
                                distance: {km: marker.distance.km, m: marker.distance.m}
                            }
                        ]);

                        xhrLatLngByDistance.then(function (data) {
                            marker.setLatLng([data.geometry.coordinates[1], data.geometry.coordinates[0]]);

                            self._rebuildPoint();
                            self._rebuildLine();
                        });
                    }
                });
            },

            _createMarker: function (latlng, distance) {
                var self = this,
                    marker = new L.Marker(latlng, {
                        draggable: true
                    });

                this._map.addLayer(marker);
                this._markers.push(marker);
                marker.distance = distance;

                marker.on('dragend', function (e) {
                    self.snapMarker(this);
                });

                return marker;
            },

            _rebuildLine: function () {
                if (this.options.activeMode !== 'line') {
                    return;
                }

                var self = this,
                    markersCount = this._markers.length,
                    xhrGetIncidentLine;

                if (markersCount < 2) {
                    return;
                }

                this._editorLayer.clearLayers();

                xhrGetIncidentLine = this.options.ngwServiceFacade.getIncidentLine(
                    this.options.roadGuid,
                    {distance: this._distances.begin},
                    {distance: this._distances.end}
                );

                xhrGetIncidentLine.then(function (data) {
                    self._editorLayer.addData(data);
                });
            },

            _rebuildPoint: function () {
                if (this.options.activeMode !== 'point') {
                    return;
                }

                this._editorLayer.clearLayers();
                this._editorLayer.addData(this._markers[0].toGeoJSON());
            },

            getGeoJsonData: function () {
                if (this._editorLayer.getLayers().length > 0) {
                    return this._editorLayer.toGeoJSON().features[0];
                } else {
                    return null;
                }
            }
        });
    });




