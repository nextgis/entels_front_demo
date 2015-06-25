<%inherit file="../_master.mako"/>

<%block name="html_attrs">class="full-screen"</%block>

<%block name="content">
    <div id="map">
        <p class="loaded-status">Построение демо-карты...</p>
    </div>
</%block>


<%block name="inlineScripts">
    <script>
        var application_lang = '${lang}';
    </script>
    <script src="${request.static_url('entels_demo:static/js/pages/entels_map.js')}"></script>
</%block>