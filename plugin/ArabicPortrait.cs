using System;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using UnityEngine;
using UnityEngine.UIElements;

namespace ArabicFix
{
    // Moves the mouth already drawn in a custom portrait. No second face is overlaid.
    public static class Portrait
    {
        private static readonly ConditionalWeakTable<object, AnimatedHead> heads = new ConditionalWeakTable<object, AnimatedHead>();
        private static object Field(object value, string name) { return value.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(value); }
        private static float Number(string json, string name, float fallback, float min, float max)
        {
            var match = Regex.Match(json, "\"" + name + "\"\\s*:\\s*([0-9.]+)");
            float value;
            return match.Success && float.TryParse(match.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value)
                ? Mathf.Clamp(value, min, max) : fallback;
        }
        public static void Bind(bool success, object presenter, string id)
        {
            Unbind(presenter);
            if (!success || !Regex.IsMatch(id ?? "", "^brave-[a-f0-9]{32}$")) return;
            try
            {
                string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "LocalLow", "Jatater Worldwide", "Scam With Your Friends", "Character Creator", id, "brave-character.json");
                if (!File.Exists(file)) return;
                string json = File.ReadAllText(file);
                if (!Regex.IsMatch(json, "\"mouthAnimation\"\\s*:\\s*true")) return;
                var layer = Field(presenter, "m_headLayer") as VisualElement;
                if (layer == null) return;
                var texture = layer.style.backgroundImage.value.texture;
                if (texture == null) return;
                var head = new AnimatedHead(texture, Number(json, "mouthX", .54f, .05f, .95f), Number(json, "mouthY", .69f, .05f, .95f), Number(json, "mouthWidth", .32f, .1f, .6f));
                layer.Add(head);
                layer.style.backgroundImage = new StyleBackground(StyleKeyword.None);
                var eyes = Field(presenter, "m_eyesLayer") as VisualElement;
                var mouth = Field(presenter, "m_mouthLayer") as VisualElement;
                if (eyes != null) eyes.style.display = DisplayStyle.None;
                if (mouth != null) mouth.style.display = DisplayStyle.None;
                heads.Add(presenter, head);
            }
            catch (Exception e) { Debug.LogWarning("[brave] Portrait animation unavailable: " + e.Message); }
        }
        public static void Mouth(object presenter, bool open)
        {
            AnimatedHead head;
            if (presenter != null && heads.TryGetValue(presenter, out head)) head.SetOpen(open);
        }
        public static void Unbind(object presenter)
        {
            AnimatedHead old;
            if (presenter != null && heads.TryGetValue(presenter, out old)) { old.RemoveFromHierarchy(); heads.Remove(presenter); }
        }
        // Smooth local compression keeps the eyes, hair and portrait silhouette stationary.
        public static float WarpY(float x, float y, float cx, float cy, float width, float openness)
        {
            double nx = (x-cx)/(width*.65), ny = (y-cy)/.095;
            double influence = Math.Exp(-Math.Pow(nx, 6)-Math.Pow(ny, 4));
            return y + (cy-y) * .58f * (1-Math.Max(0, Math.Min(1, openness))) * (float)influence;
        }
        private sealed class AnimatedHead : VisualElement
        {
            private readonly Texture2D texture;
            private readonly float cx, cy, width;
            private float openness;
            public AnimatedHead(Texture2D image, float x, float y, float mouthWidth)
            {
                texture=image;cx=x;cy=y;width=mouthWidth;pickingMode=PickingMode.Ignore;
                name="brave-animated-head";
                style.position=Position.Absolute;style.left=0;style.right=0;style.top=0;style.bottom=0;
                generateVisualContent += Draw;
            }
            public void SetOpen(bool open)
            {
                float next = Mathf.MoveTowards(openness, open?1f:0f, Mathf.Min(.08f,Time.unscaledDeltaTime)*12f);
                if (Mathf.Abs(next-openness)<.001f) return;
                openness=next;MarkDirtyRepaint();
            }
            private void Draw(MeshGenerationContext context)
            {
                if (texture == null || contentRect.width<1 || contentRect.height<1) return;
                const int grid=40, stride=grid+1;
                float scale=Mathf.Min(contentRect.width/texture.width,contentRect.height/texture.height);
                float w=texture.width*scale,h=texture.height*scale,left=(contentRect.width-w)/2,top=(contentRect.height-h)/2;
                var mesh=context.Allocate(stride*stride,grid*grid*6,texture);
                for(int row=0;row<=grid;row++) for(int col=0;col<=grid;col++)
                {
                    float x=(float)col/grid,y=(float)row/grid;
                    mesh.SetNextVertex(new Vertex {position=new Vector3(left+x*w,top+WarpY(x,y,cx,cy,width,openness)*h,Vertex.nearZ),tint=Color.white,uv=new Vector2(x,1-y)});
                }
                for(int row=0;row<grid;row++) for(int col=0;col<grid;col++)
                {
                    ushort a=(ushort)(row*stride+col),b=(ushort)(a+1),d=(ushort)(a+stride),c=(ushort)(d+1);
                    mesh.SetNextIndex(a);mesh.SetNextIndex(b);mesh.SetNextIndex(c);
                    mesh.SetNextIndex(a);mesh.SetNextIndex(c);mesh.SetNextIndex(d);
                }
            }
        }
    }
}
