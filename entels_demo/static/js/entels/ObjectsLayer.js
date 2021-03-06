define([
    'dojo/_base/declare',
    'dojo/_base/lang',
    'dojo/_base/array',
    'dojo/topic',
    'dojo/request/xhr',
    'dojo/i18n',
    'dojo/Deferred',
    'dojo/string',
    'dojox/lang/functional/object',
    'entels/StyledGeoJsonLayer',
    'entels/ParametersVerification',
    'mustache/mustache',
    'dojo/text!entels/templates/' + application_lang + '/Tooltip.html',
    'dojo/text!entels/templates/' + application_lang + '/AttributesPopup.html',
    'leaflet/turf/turf'
], function (declare, lang, array, topic, xhr, i18n, Deferred, string, obj, StyledGeoJsonLayer,
             ParametersVerification, mustache, TooltipTemplate, AttributesPopupTemplate, turf) {
    return declare('entels.ObjectsLayer', [StyledGeoJsonLayer, ParametersVerification], {
        constructor: function () {
            this.verificateRequiredParameters(this.options, [
                'ngwServiceFacade',
                'layersInfo',
                'map',
                'layerKeyname',
                'scadaServiceFacade',
                'fieldId',
                'states'
            ]);
            this._objects_layer_id = this.options.layersInfo.getLayersDictByKeyname()[this.options.layerKeyname].layer_id;
        },

        tooltips: {},

        onAdd: function (map) {
            StyledGeoJsonLayer.prototype.onAdd.call(this, map);
            this._hookMap(map);
            this._buildObjects().then(lang.hitch(this, function (guids) {
                if (this._checkWebSocketSupport()) {
                    this._subscribeObjectStatuses(guids);
                }
            }));
        },

        onRemove: function (map) {
            this._unhookMap(map);
            StyledGeoJsonLayer.prototype.onRemove.call(this, map);
        },

        _hookMap: function (map) {
            map.on('moveend', this._buildObjects, this);
        },

        _unhookMap: function (map) {
            map.off('moveend', this._buildObjects, this);
        },

        _changeStyle: function (id, style) {
            var layer = this.layersById[id];
            if (!layer) return false;

            if (layer.feature.properties.__type === style) {
                return false;
            }

            var geoJsonFeature = lang.clone(layer.feature);
            if (this.tooltips[id]) {
                array.forEach(this.tooltips[id], function (tooltip) {
                    tooltip.hide();
                    tooltip.remove();
                }, this);
            }
            delete this.tooltips[id];
            this.removeObject(id);

            var markerLayer = this.addObject(geoJsonFeature, style, id);
            topic.publish('map/objects/style/changed', id, style);
            this._markerLayerBindEvents(markerLayer, geoJsonFeature.properties, style);
        },

        _markerLayerBindEvents: function (markerLayer, objectProps, state) {
            var markers = this.getMarkers(markerLayer),
                lmap = this.options.map._lmap,
                currentDate = new Date(),
                currentTime = string.pad(currentDate.getHours(), 2) + ':' +
                    string.pad(currentDate.getMinutes(), 2) + ':' +
                    string.pad(currentDate.getSeconds(), 2);
            objectProps.state = this.options.states[state];
            objectProps.lastTime = currentTime;
            array.forEach(markers, function (marker) {
                var id = objectProps[this.options.fieldId];
                marker._id = id;

                if (!this.tooltips[id]) {
                    this.tooltips[id] = [];
                }

                this.tooltips[id].push(
                    L.tooltip({
                        target: marker,
                        map: lmap,
                        html: mustache.render(TooltipTemplate, objectProps),
                        showDelay: 0,
                        hideDelay: 0
                    })
                );

                marker.on('click', lang.hitch(this, function (markerClicked) {
                    this.options.scadaServiceFacade.getAttributesById(markerClicked.target._id)
                        .then(lang.hitch(this, function (result) {
                            var attrs = result.attrs;
                            for (var i = 0, l = attrs.length; i < l; i++) {
                                var attr = attrs[i];
                                if (attr.type) {
                                    attrs[i]['is_' + attr.type] = true;
                                }
                            }
                            lmap.openPopup(mustache.render(AttributesPopupTemplate, result), markerClicked.latlng);
                        }), lang.hitch(this, function (error) {
                            lmap.openPopup(this.options.popupErrorMessage, markerClicked.latlng);
                            if (this.options.debug) {
                                console.log(this.options.popupErrorMessage);
                                console.log(error);
                            }
                        }));
                }));
            }, this);
        },

        _buildObjects: function () {
            var bounds = this.options.map.getLMap().getBounds(),
                bounds3857 = {
                    _southWest: L.CRS.EPSG3857.project(bounds._southWest),
                    _northEast: L.CRS.EPSG3857.project(bounds._northEast)
                },
                extent3857 = [bounds3857._southWest.x, bounds3857._southWest.y, bounds3857._northEast.x, bounds3857._northEast.y],
                deferred = new Deferred(),
                timestamp = Date.now();

            this.options.ngwServiceFacade.identifyFeaturesByLayers([this._objects_layer_id], extent3857, 3857)
                .then(lang.hitch(this, function (objectsGeometry) {
                    var guids = [],
                        currentObject;

                    for (var i = 0, count = objectsGeometry.features.length; i < count; i++) {
                        var objectProps = objectsGeometry.features[i].properties,
                            object_guid = objectProps[this.options.fieldId];

                        guids.push(object_guid);

                        currentObject = this.getObjectById(object_guid);
                        if (!currentObject) {
                            currentObject = this.addObject(objectsGeometry.features[i], 'wait', object_guid);
                            this._markerLayerBindEvents(currentObject, objectProps, 'wait');
                        }

                        this.layersById[object_guid].__ts = timestamp;
                    }

                    if (this._ws) {
                        this._addNewObjsToSubsrcibe(guids);
                    }

                    this._removeHidingObjects(timestamp);

                    topic.publish('map/objects/rendered');

                    deferred.resolve(guids);
                }));

            return deferred.promise;
        },

        _removeHidingObjects: function (timestamp) {
            var objects = this.layersById,
                objectId,
                objectLayer;

            for (objectId in objects) {
                objectLayer = objects[objectId];
                if (objectLayer.__ts !== timestamp) {
                    this.removeLayer(objectLayer);
                    delete objects[objectId];
                }
            }
        },

        _checkWebSocketSupport: function () {
            if (typeof(WebSocket) !== 'function' && typeof(WebSocket) !== 'object') {
                alert(this.options.wsSupportErrorMessage);
                return false;
            } else {
                return true;
            }
        },

        _ws: null,
        _subscribeObjectStatuses: function (guidsObjs) {
            var ws = new WebSocket(scadaWebSockectUrl),
                guids = guidsObjs || obj.keys(this.layersById).join(',');

            this._ws = ws;

            ws.onmessage = lang.hitch(this, function (e) {
                try {
                    var result = JSON.parse(e.data),
                        objs = result.objs,
                        obj, id;

                    for (var i = 0, l = objs.length; i < l; i++) {
                        obj = objs[i];
                        id = obj.id;
                        array.forEach(obj.attrs, function (attr) {
                            if (attr.name === 'Cod') {
                                this._changeStyle(id, attr.value);
                            }
                        }, this);
                    }
                    console.log('web_socket: ' + l);
                } catch (err) {
                    if (this.options.debug) {
                        console.log(err);
                    }
                }
            });

            ws.onopen = lang.hitch(this, function () {
                if (this.options.debug) console.log('opening...');
                ws.send('GET_NEW ' + guids);
            });

            ws.onerror = function (error) {
                if (this.options.debug) console.log('WEbSocket error ' + error);
                if (this.options.debug) console.dir(error);
            };
        },

        _addNewObjsToSubsrcibe: function (guids) {
            if (guids.length > 0) {
                this._ws.send('GET_OBJ ' + guids);
            }
        },

        getVisibleObjects: function () {
            var turfPolygonBounds = this._createPolygonFromBounds(),
                objects = [],
                pointFeature,
                firstPoint;

            array.forEach(this.getLayers(), function (layer) {
                firstPoint = layer.feature.geometry.coordinates[0];
                pointFeature = {
                    'type': 'Feature',
                    'properties': {},
                    'geometry': {
                        'type': 'Point',
                        'coordinates': [firstPoint[0], firstPoint[1]]
                    }
                };
                if (turf.inside(pointFeature, turfPolygonBounds)) {
                    objects.push(layer.feature);
                }
            });

            return objects;
        },

        _createPolygonFromBounds: function (latLngBounds) {
            //var center = latLngBounds.getCenter();
            var latlngs = [],
                turfLonLat = [];

            if (!latLngBounds) {
                latLngBounds = this._map.getBounds();
            }

            latlngs.push(latLngBounds.getSouthWest());//bottom left
            latlngs.push(latLngBounds.getNorthWest());//top left
            latlngs.push(latLngBounds.getNorthEast());//top right
            latlngs.push(latLngBounds.getSouthEast());//bottom right
            latlngs.push(latLngBounds.getSouthWest());//bottom left

            array.forEach(latlngs, function (latlng) {
                turfLonLat.push([latlng.lng, latlng.lat]);
            });

            return turf.polygon([turfLonLat], {});
        }
    });
});