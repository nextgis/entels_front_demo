from pyramid.view import view_config


@view_config(route_name='index', renderer='index.mako')
def index(request):
    return {}


@view_config(route_name='widgets_list', renderer='widgets_list.mako')
def widgets_list(request):
    return {}


@view_config(route_name='wms', renderer='wms.mako')
def wms(request):
    return {}


@view_config(route_name='layers', renderer='layers.mako')
def layers(request):
    return {}


@view_config(route_name='base_layers', renderer='base_layers.mako')
def base_layers(request):
    return {}


@view_config(route_name='entels_map', renderer='entels/map.mako')
def entels_map(request):
    return {}


@view_config(route_name='entels_map_full', renderer='entels/map_full_screen.mako')
def map_full_screen(request):
    return {}
